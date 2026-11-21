#!/usr/bin/env python3
"""Attach each paper's own mark-scheme pages to the questions that have no answer of their own.

    python3 -m pdf_extraction.bank.build_paper_guides            # report only
    python3 -m pdf_extraction.bank.build_paper_guides --apply

Many mark schemes are not a list of per-question answers: Literature and
language papers ship a marking guide with generic level descriptors, Art has
none that is per question, and several table-format schemes never parsed into
rows. A student opening one of those questions is told "No mark scheme for this
question yet" even though the paper's mark scheme sits in the corpus.

This renders the pages of the matching mark-scheme PDF and records them against
the *question paper* in `bank_paper_guides`. The app shows them, labelled as the
paper's marking guidance rather than as the answer, on exactly the questions that
have no mark scheme of their own.

A question paper gets a guide only when
  * at least one of its published questions has no mark scheme with strips or a
    letter, and
  * exactly one mark-scheme PDF fits its sitting (same subject, year, session,
    paper number, variant and timezone; an IB HL/SL level must agree, HLSL fits
    either), preferring an exact level match, and
  * that PDF has at most MAX_PAGES pages.

Nothing calls a model. Re-running is safe: a paper that already has a guide is
left alone unless --rebuild is given.
"""
from __future__ import annotations

import argparse
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

import fitz

from . import store
from .renderer import MAX_STRIP_EDGE, _capped_scale, _store_asset

DB = Path(__file__).with_name("extract.db")
ASSETS = Path(__file__).resolve().parent / "assets"
MAX_PAGES = 40

SCHEMA = """
CREATE TABLE IF NOT EXISTS bank_paper_guides (
    paper_id INTEGER NOT NULL REFERENCES bank_papers(id),
    ordering INTEGER NOT NULL,
    asset_id INTEGER NOT NULL REFERENCES bank_assets(id),
    page INTEGER NOT NULL,
    ms_paper_id INTEGER NOT NULL REFERENCES bank_papers(id),
    PRIMARY KEY (paper_id, ordering)
)
"""

_LEVEL = re.compile(r"_(HLSL|HL|SL)(?:_|\.|$)", re.IGNORECASE)


def level(path: str) -> str | None:
    match = _LEVEL.search(Path(path).stem + ".")
    return match.group(1).upper() if match else None


def level_fits(a: str, b: str) -> int:
    """2 = same level, 1 = compatible (one side HLSL or unknown), 0 = clash."""
    la, lb = level(a), level(b)
    if la is None or lb is None:
        return 1
    if la == lb:
        return 2
    return 1 if "HLSL" in (la, lb) else 0


CANDIDATES = """
    SELECT qp.id AS qp_id, qp.source_path AS qp_path, count(*) AS missing
      FROM bank_papers qp
      JOIN bank_questions q ON q.paper_id = qp.id AND q.status = 'published'
     WHERE qp.doc_type IN ('qp', 'in')
       AND NOT EXISTS (
            SELECT 1 FROM bank_mark_schemes m
             WHERE m.question_id = q.id
               AND (m.answer_letter IS NOT NULL
                    OR EXISTS (SELECT 1 FROM bank_mark_scheme_strips s WHERE s.mark_scheme_id = m.id)))
     GROUP BY qp.id
"""

MS_FOR = """
    SELECT ms.id, ms.source_path, ms.page_count FROM bank_papers ms
      JOIN bank_papers qp ON qp.id = ?
     WHERE ms.doc_type = 'ms' AND ms.subject_id = qp.subject_id
       AND ms.year = qp.year AND ms.session = qp.session
       AND ms.paper_number = qp.paper_number AND ms.variant = qp.variant
       AND IFNULL(ms.timezone, '') = IFNULL(qp.timezone, '')
"""


def pick_ms(connection: sqlite3.Connection, qp_id: int, qp_path: str):
    options = [
        (level_fits(row["source_path"], qp_path), row)
        for row in connection.execute(MS_FOR, (qp_id,))
    ]
    options = [(fit, row) for fit, row in options if fit > 0]
    if not options:
        return None, "no mark-scheme pdf"
    best = max(fit for fit, _ in options)
    top = [row for fit, row in options if fit == best]
    if len(top) != 1:
        return None, "ambiguous mark-scheme pdfs"
    return top[0], None


def render_pages(pdf_path: Path, asset_root: Path) -> list[tuple[int, object]]:
    out = []
    assets: dict = {}
    with fitz.open(pdf_path) as document:
        for page in document:
            rect = page.rect
            scale = _capped_scale(rect, MAX_STRIP_EDGE)
            pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False, colorspace=fitz.csGRAY)
            asset = _store_asset(
                data=pixmap.tobytes("png"), kind="screenshot", asset_root=asset_root, assets=assets,
                source_page=page.number + 1, bbox=(rect.x0, rect.y0, rect.x1, rect.y1),
                width=pixmap.width, height=pixmap.height, dpi=round(scale * 72.0),
            )
            out.append((page.number + 1, asset))
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--rebuild", action="store_true", help="replace guides that already exist")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()

    connection = store.connect(DB)
    connection.execute("PRAGMA busy_timeout = 30000")
    connection.row_factory = sqlite3.Row
    connection.execute(SCHEMA)

    have = {row[0] for row in connection.execute("SELECT DISTINCT paper_id FROM bank_paper_guides")}
    plan: list[tuple[int, int, Path, int, int]] = []
    skipped: Counter[str] = Counter()
    for row in connection.execute(CANDIDATES).fetchall():
        if row["qp_id"] in have and not args.rebuild:
            skipped["already has a guide"] += 1
            continue
        ms, why = pick_ms(connection, row["qp_id"], row["qp_path"])
        if ms is None:
            skipped[why] += 1
            continue
        if (ms["page_count"] or 0) > MAX_PAGES:
            skipped[f"mark scheme longer than {MAX_PAGES} pages"] += 1
            continue
        if not Path(ms["source_path"]).exists():
            skipped["pdf missing on disk"] += 1
            continue
        plan.append((row["qp_id"], ms["id"], Path(ms["source_path"]), ms["page_count"] or 0, row["missing"]))

    subjects: Counter[str] = Counter()
    for qp_id, _, _, pages, missing in plan:
        code = connection.execute(
            "SELECT s.code FROM bank_papers p JOIN bank_subjects s ON s.id = p.subject_id WHERE p.id = ?",
            (qp_id,)).fetchone()[0]
        subjects[code] += missing
    print(f"{len(plan)} question papers would get a guide "
          f"({sum(p[3] for p in plan)} pages, {sum(p[4] for p in plan)} questions covered)")
    for code, count in subjects.most_common(25):
        print(f"  {code:45s} {count}")
    for why, count in skipped.items():
        print(f"  skipped {count}: {why}")
    if not args.apply:
        print("Report only. Re-run with --apply.")
        return

    by_ms: dict[int, list[int]] = defaultdict(list)
    for qp_id, ms_id, path, _, _ in plan:
        by_ms[ms_id].append(qp_id)
    paths = {ms_id: path for _, ms_id, path, _, _ in plan}
    done = 0
    for ms_id, qp_ids in list(by_ms.items())[: args.limit]:
        pages = render_pages(paths[ms_id], ASSETS)
        asset_ids = [(page, store.upsert_asset(connection, asset)) for page, asset in pages]
        for qp_id in qp_ids:
            connection.execute("DELETE FROM bank_paper_guides WHERE paper_id = ?", (qp_id,))
            connection.executemany(
                "INSERT INTO bank_paper_guides (paper_id, ordering, asset_id, page, ms_paper_id) VALUES (?, ?, ?, ?, ?)",
                [(qp_id, i, asset_id, page, ms_id) for i, (page, asset_id) in enumerate(asset_ids)],
            )
        connection.commit()
        done += 1
        if done % 25 == 0:
            print(f"  {done}/{len(by_ms)} mark-scheme pdfs rendered", flush=True)
    print(f"guides written for {sum(len(v) for v in by_ms.values())} question papers")


if __name__ == "__main__":
    main()
