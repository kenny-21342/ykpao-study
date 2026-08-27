#!/usr/bin/env python3
"""
Recompute crop QA flags without re-rendering anything.

    python3 -m pdf_extraction.bank.requalify            # every paper
    python3 -m pdf_extraction.bank.requalify --limit 50 # a sample first
    python3 -m pdf_extraction.bank.requalify --dry-run  # report, write nothing

When a check changes, the flags already in the store were produced by the old
one. Re-running the corpus would fix them, but rendering is the expensive part
and the strips have not changed — a paper's crops are already on disk and
already recorded.

So this reads the strip geometry back out of the store and re-runs stage 1,
which is deterministic and costs a fraction of a render. Roughly half a second
a paper against two and a half.

Questions whose status was decided by the old flags are re-decided by the new
ones, so a paper held out of the merge for a check that has since been
corrected is released by this rather than waiting for a full re-run.

Do not run the writing form while a corpus run is in progress: SQLite takes
one writer, and the two would contend for the whole pass. --dry-run is
read-only and safe at any time.
"""
from __future__ import annotations

import argparse
import sqlite3
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from . import store
from .qa import run_crop_checks
from .run import _crop_status, _drop_paper_wide_marks_flag
from .spans import detect_root_spans

DB = Path(__file__).resolve().parent / "extract.db"


@dataclass(frozen=True)
class StoredStrip:
    """The parts of a rendered strip the crop checks actually read."""

    page: int
    bbox: tuple[float, float, float, float]


@dataclass(frozen=True)
class StoredSpan:
    root_number: int
    strips: tuple[StoredStrip, ...]


def load_strips(connection, paper_id: int) -> dict[int, StoredSpan]:
    """Rebuild each question's crop geometry from the store."""
    rows = connection.execute(
        """
        SELECT q.root_number, s.ordering, s.page, a.bbox
        FROM bank_questions q
        JOIN bank_question_strips s ON s.question_id = q.id
        JOIN bank_assets a ON a.id = s.asset_id
        WHERE q.paper_id = ?
        ORDER BY q.root_number, s.ordering
        """,
        (paper_id,),
    ).fetchall()

    import json

    grouped: dict[int, list[StoredStrip]] = {}
    for row in rows:
        try:
            bbox = tuple(float(value) for value in json.loads(row["bbox"]))
        except Exception:
            continue
        if len(bbox) != 4:
            continue
        grouped.setdefault(int(row["root_number"]), []).append(
            StoredStrip(page=int(row["page"]), bbox=bbox)
        )
    return {
        root: StoredSpan(root_number=root, strips=tuple(strips))
        for root, strips in grouped.items()
    }


def requalify_paper(connection, paper, dry_run: bool) -> Counter:
    tally: Counter = Counter()
    source = Path(paper["source_path"])
    if not source.exists():
        tally["missing_source"] += 1
        return tally

    stored = load_strips(connection, paper["id"])
    if not stored:
        tally["no_strips"] += 1
        return tally

    # Stage 1 again: cheap, deterministic, and the only place the erase boxes
    # the checks need are described.
    spans = detect_root_spans(source, paper["doc_type"])
    by_root = {span.root_number: span for span in spans.spans}

    flags_by_root = {}
    for root, rendered in stored.items():
        span = by_root.get(root)
        if span is None:
            tally["span_gone"] += 1
            continue
        flags_by_root[root] = run_crop_checks(
            source, span, rendered, paper["doc_type"], paper["id"]
        )
    _drop_paper_wide_marks_flag(flags_by_root)

    for root, flags in flags_by_root.items():
        row = connection.execute(
            "SELECT id, confidence, status FROM bank_questions "
            "WHERE paper_id = ? AND root_number = ?",
            (paper["id"], root),
        ).fetchone()
        if row is None:
            continue
        status = _crop_status(flags, row["confidence"])
        tally[f"status:{status}"] += 1
        for flag in flags:
            tally[flag.issue_type] += 1
        if dry_run:
            continue
        connection.execute(
            "DELETE FROM bank_review_flags WHERE question_id = ?", (row["id"],)
        )
        if flags:
            store.record_flags(
                connection, question_id=row["id"], paper_id=paper["id"], flags=flags
            )
        connection.execute(
            "UPDATE bank_questions SET status = ? WHERE id = ?", (status, row["id"])
        )
    return tally


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DB)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument(
        "--subject",
        default=None,
        help=(
            "only papers of this syllabus code or IB slug. Statuses are "
            "re-decided against the CURRENT erase boxes, so a subject that has "
            "not been re-rendered yet would be judged on boxes its stored "
            "crops were not made with."
        ),
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.dry_run:
        # Read-only: a dry run must not open a write transaction against a
        # store the corpus run may be writing to.
        connection = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
    else:
        connection = store.connect(args.db)
    where = "doc_type != 'ms'"
    params: tuple = ()
    if args.subject:
        where += (" AND subject_id IN (SELECT id FROM bank_subjects WHERE code = ?)")
        params = (args.subject,)
    papers = connection.execute(
        f"SELECT id, source_path, doc_type FROM bank_papers WHERE {where} ORDER BY id"
        + (f" LIMIT {args.limit}" if args.limit else ""),
        params,
    ).fetchall()

    print(f"{len(papers)} papers" + (" (dry run)" if args.dry_run else ""), flush=True)
    started = time.time()
    totals: Counter = Counter()
    for index, paper in enumerate(papers, 1):
        try:
            totals.update(requalify_paper(connection, paper, args.dry_run))
        except Exception as error:
            totals[f"error:{type(error).__name__}"] += 1
        if index % 200 == 0:
            if not args.dry_run:
                connection.commit()
            rate = index / max(time.time() - started, 1e-6)
            print(f"  {index}/{len(papers)}  {rate:.1f} papers/s", flush=True)
    if not args.dry_run:
        connection.commit()
    connection.close()

    published = totals.get("status:published", 0)
    review = totals.get("status:needs_review", 0)
    total = published + review
    print(f"\n{total} questions: {published} published "
          f"({100 * published / max(total, 1):.1f}%), {review} needs_review")
    for key, count in sorted(totals.items()):
        if not key.startswith("status:"):
            print(f"  {key:26} {count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
