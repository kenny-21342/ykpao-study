"""Measure what dropping IB's generic marking-notes pages changes, before re-extracting.

    python3 -m pdf_extraction.bank.audit_ms_notes [--limit N] [--out report.jsonl]

For every IB prose mark scheme in extract.db, runs root detection twice --
with and without `spans.ms_notes_cutoffs` -- and compares the roots found
against the matching question paper's roots. Free: no model calls.

A paper is reported as
  improved  -- fewer roots the question paper does not have, or more it does
  same      -- identical root numbers
  worse     -- loses a question-paper root, or gains extras
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from . import spans as spans_module
from .run import _question_paper_roots
from .store import parse_paper_path  # noqa: F401  (imported for its side effect of validating paths)

DB = Path(__file__).with_name("extract.db")


def _roots(path: str, expected: frozenset[int] | None, notes: bool) -> list[int]:
    original = spans_module.ms_notes_cutoffs
    if not notes:
        spans_module.ms_notes_cutoffs = lambda evidence: {}
    try:
        result = spans_module.detect_root_spans(Path(path), "ms", expected_roots=expected)
    finally:
        spans_module.ms_notes_cutoffs = original
    return sorted(span.root_number for span in result.spans)


def _one(job: tuple[str, list[int] | None]) -> dict:
    path, expected_list = job
    expected = frozenset(expected_list) if expected_list else None
    try:
        before = _roots(path, expected, notes=False)
        after = _roots(path, expected, notes=True)
    except Exception as error:  # noqa: BLE001 -- a report, not a pipeline step
        return {"path": path, "error": repr(error)}
    exp = set(expected or ())

    def score(roots: list[int]) -> tuple[int, int]:
        return len(set(roots) & exp), len(set(roots) - exp)

    hit_b, extra_b = score(before)
    hit_a, extra_a = score(after)
    if before == after:
        verdict = "same"
    elif not exp:
        verdict = "improved" if len(after) < len(before) and after else "check"
    elif hit_a >= hit_b and extra_a <= extra_b:
        verdict = "improved"
    else:
        verdict = "worse"
    return {"path": path, "expected": sorted(exp), "before": before, "after": after, "verdict": verdict}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int)
    parser.add_argument("--out", default="ms_notes_audit.jsonl")
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--paths-file", help="only these source paths, one per line")
    args = parser.parse_args()

    connection = sqlite3.connect(DB)
    rows = connection.execute(
        "SELECT source_path FROM bank_papers WHERE board='IB' AND doc_type='ms' "
        "AND span_strategy IN ('prose','prose_ms_numbered') ORDER BY source_path"
    ).fetchall()
    if args.paths_file:
        wanted = {line.strip() for line in open(args.paths_file) if line.strip()}
        rows = [row for row in rows if row[0] in wanted]
    jobs = []
    for (path,) in rows[: args.limit]:
        identity = spans_module_identity(path)
        expected = _question_paper_roots(connection, identity) if identity else None
        jobs.append((path, sorted(expected) if expected else None))

    counts: dict[str, int] = {}
    with open(args.out, "w") as out, ProcessPoolExecutor(args.workers) as pool:
        for index, result in enumerate(pool.map(_one, jobs, chunksize=4), 1):
            out.write(json.dumps(result) + "\n")
            verdict = result.get("verdict", "error")
            counts[verdict] = counts.get(verdict, 0) + 1
            if index % 100 == 0:
                print(index, counts, file=sys.stderr, flush=True)
    print(counts)


def spans_module_identity(path: str):
    from .store import parse_paper_path as parse
    return parse(Path(path))


if __name__ == "__main__":
    main()
