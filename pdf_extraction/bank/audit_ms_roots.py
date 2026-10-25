"""Dry run: would the fixed mark-scheme heading selection recover more questions?

For every IB prose mark scheme this re-detects the headings with the current
`select_numbered_ms_roots` and compares them with what the store already holds,
both measured against the question numbers the matching question paper has.
Nothing is written to the store.

    python3 -m pdf_extraction.bank.audit_ms_roots [--workers 4] [--out report.json]
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from multiprocessing import Pool
from pathlib import Path

from .spans import detect_root_spans

DB = Path(__file__).with_name("extract.db")

IDENT = """SELECT s.code, p.year, p.session, p.paper_number, p.variant, coalesce(p.timezone, '')"""


def _expected(connection: sqlite3.Connection, paper_id: int) -> frozenset[int]:
    """Question numbers of the question paper(s) this mark scheme belongs to."""
    rows = connection.execute(
        """SELECT DISTINCT q.root_number FROM bank_papers m
           JOIN bank_subjects ms ON ms.id = m.subject_id
           JOIN bank_subjects qs ON qs.code = ms.code AND qs.board = ms.board
           JOIN bank_papers p ON p.subject_id = qs.id AND p.doc_type = 'qp'
             AND p.year = m.year AND p.session = m.session
             AND p.paper_number = m.paper_number AND p.variant = m.variant
             AND coalesce(p.timezone, '') = coalesce(m.timezone, '')
           JOIN bank_questions q ON q.paper_id = p.id
           WHERE m.id = ?""",
        (paper_id,),
    ).fetchall()
    return frozenset(row[0] for row in rows)


def _job(args: tuple[int, str, list[int], list[int]]) -> dict:
    paper_id, path, stored, expected = args
    try:
        from .spans import extract_document_evidence
        evidence = extract_document_evidence(Path(path))
        spans = detect_root_spans(path, "ms", evidence=evidence, expected_roots=frozenset(expected) or None)
        before = detect_root_spans(path, "ms", evidence=evidence)
        key = spans.answer_key
        new = sorted(int(n) for n in (key.keys() if isinstance(key, dict) else [k[0] if isinstance(k, (tuple, list)) else k for k in key])) if key else sorted(span.root_number for span in spans.spans)
        old = sorted(int(n) for n in ([k[0] for k in before.answer_key] if before.answer_key
                                      else [span.root_number for span in before.spans]))
        return {"id": paper_id, "path": path, "stored": stored, "old": old, "new": new,
                "expected": expected, "strategy": spans.strategy}
    except Exception as error:  # noqa: BLE001 - a bad PDF must not stop the audit
        return {"id": paper_id, "path": path, "stored": stored, "new": None, "expected": expected,
                "error": str(error)[:200]}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--out", default="pdf_extraction/bank/ms_root_audit.json")
    parser.add_argument("--board", default="IB")
    args = parser.parse_args()

    connection = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    papers = connection.execute(
        "SELECT id, source_path FROM bank_papers WHERE doc_type = 'ms' AND board = ? "
        "AND span_strategy IN ('prose', 'prose_ms_numbered')",
        (args.board,),
    ).fetchall()
    jobs = []
    for paper_id, path in papers:
        stored = [r[0] for r in connection.execute(
            "SELECT root_number FROM bank_mark_schemes WHERE paper_id = ?", (paper_id,))]
        jobs.append((paper_id, path, sorted(stored), sorted(_expected(connection, paper_id))))
    connection.close()
    print(f"{len(jobs)} mark schemes", flush=True)

    results = []
    with Pool(args.workers) as pool:
        for index, result in enumerate(pool.imap_unordered(_job, jobs, chunksize=4), 1):
            results.append(result)
            if index % 100 == 0:
                print(f"  {index}/{len(jobs)}", flush=True)
    Path(args.out).write_text(json.dumps(results))

    better = worse = same = errors = 0
    gained = lost = 0
    for r in results:
        if r["new"] is None:
            errors += 1
            continue
        expected = set(r["expected"])
        if not expected:
            continue
        before = len(expected & set(r["old"]))
        after = len(expected & set(r["new"]))
        if after > before:
            better += 1
            gained += after - before
        elif after < before:
            worse += 1
            lost += before - after
        else:
            same += 1
    print(f"covered questions: better {better} papers (+{gained}), worse {worse} (-{lost}), "
          f"same {same}, errors {errors}")


if __name__ == "__main__":
    main()
