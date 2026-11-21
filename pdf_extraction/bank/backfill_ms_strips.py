#!/usr/bin/env python3
"""Give transcribed mark schemes their image strips, with no model and no text change.

    python3 -m pdf_extraction.bank.backfill_ms_strips            # report only
    python3 -m pdf_extraction.bank.backfill_ms_strips --apply

The app shows a mark scheme only as image strips (or a one-letter answer), never
as stored text. Some mark-scheme papers were transcribed on a path that recorded
the answer text but not the crops, so ~700 published answers read "no mark scheme
yet" although the answer is sitting in the database.

For each such paper this re-runs the free stages (span detection, rendering) and
links the crops to the rows that already exist. It never touches answer_md,
marking points or status -- `run_corpus(use_model=False)` would, because it
rewrites the row from a crop-only stub, which is why it is not used here.

A paper is only filled when every root already stored for it is a heading found
today (extra headings are simply not linked). If a stored root is not found the
crops would not belong to the stored answers -- a repair or a different heading
choice is needed first -- so those papers are listed and left alone.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import time
from pathlib import Path

from . import store
from .renderer import render_strips_and_assets
from .run import _question_paper_roots
from .spans import detect_root_spans
from .store import parse_paper_path

DB = Path(__file__).with_name("extract.db")
ASSETS = Path(__file__).resolve().parent / "assets"
BACKUPS = Path(__file__).resolve().parents[2] / "backups"


def papers_needing_strips(connection: sqlite3.Connection) -> list[sqlite3.Row]:
    return connection.execute(
        """
        SELECT p.id, p.source_path, count(*) AS rows_missing
          FROM bank_mark_schemes m
          JOIN bank_papers p ON p.id = m.paper_id
         WHERE m.answer_letter IS NULL
           AND length(trim(m.answer_md)) > 0
           AND NOT EXISTS (SELECT 1 FROM bank_mark_scheme_strips s WHERE s.mark_scheme_id = m.id)
         GROUP BY p.id ORDER BY rows_missing DESC
        """
    ).fetchall()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    connection = store.connect(DB)
    connection.execute("PRAGMA busy_timeout = 30000")
    connection.row_factory = sqlite3.Row
    todo = papers_needing_strips(connection)
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(todo)} mark-scheme papers have answer text without strips")

    filled = 0
    linked_rows: list[list[int]] = []
    skipped: list[dict] = []
    for index, paper in enumerate(todo, 1):
        path = Path(paper["source_path"])
        if not path.exists():
            skipped.append({"path": str(path), "why": "pdf missing"})
            continue
        identity = parse_paper_path(path)
        if identity is None:
            skipped.append({"path": str(path), "why": "unrecognised name"})
            continue
        try:
            spans = detect_root_spans(
                path, "ms", expected_roots=_question_paper_roots(connection, identity))
        except Exception as error:  # noqa: BLE001 - one bad PDF must not stop the batch
            skipped.append({"path": str(path), "why": f"detect: {error}"})
            continue
        stored = {
            row["root_number"]: row["id"]
            for row in connection.execute(
                "SELECT id, root_number FROM bank_mark_schemes WHERE paper_id = ?", (paper["id"],))
        }
        found = {span.root_number for span in spans.spans}
        if not set(stored) <= found:
            skipped.append({
                "path": str(path), "why": "stored roots are not all found as headings today",
                "stored_only": sorted(set(stored) - found), "found_only": sorted(found - set(stored)),
            })
            continue
        if not args.apply:
            filled += 1
            continue
        render = render_strips_and_assets(spans, path, ASSETS)
        asset_ids = {asset.sha256: store.upsert_asset(connection, asset) for asset in render.assets}
        for span in spans.spans:
            if span.root_number not in stored:
                continue
            rendered = render.span_for(span.root_number)
            ms_id = stored[span.root_number]
            has = connection.execute(
                "SELECT 1 FROM bank_mark_scheme_strips WHERE mark_scheme_id = ?", (ms_id,)).fetchone()
            if rendered is None or not rendered.strips or has:
                continue
            store._link_mark_scheme_strips(connection, ms_id, rendered, asset_ids)
            linked_rows.append([ms_id, span.root_number])
        connection.commit()
        filled += 1
        if index % 10 == 0:
            print(f"  {index}/{len(todo)} papers, {len(linked_rows)} rows linked", flush=True)

    print(f"{filled} papers {'filled' if args.apply else 'could be filled'}; {len(skipped)} left alone")
    for item in skipped[:15]:
        print("  skipped:", item["why"], Path(item["path"]).name)
    if args.apply:
        BACKUPS.mkdir(exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        (BACKUPS / f"backfill-ms-strips-{stamp}.json").write_text(json.dumps(linked_rows))
        (BACKUPS / f"backfill-ms-strips-skipped-{stamp}.json").write_text(json.dumps(skipped, indent=1))
        print(f"linked strips for {len(linked_rows)} mark scheme rows (ids in backups/backfill-ms-strips-{stamp}.json)")


if __name__ == "__main__":
    main()
