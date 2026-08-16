#!/usr/bin/env python3
"""Pilot run: CAIE 9709 Mathematics.

Validates the pipeline end to end on one subject before committing budget to
the full corpus. Measures real cost per question from real token counts rather
than an assumed rate, and writes everything to a SQLite store that can be
inspected and then merged to Neon.

The run is resumable: the ledger is keyed per question, so re-running skips
work already completed with the same model and prompt version.

Usage:
    python scripts/pilot_9709.py --dry-run          # stages 1-2 only, free
    python scripts/pilot_9709.py --limit 10         # 10 documents, with model
    python scripts/pilot_9709.py --max-questions 4  # cap spend per document
    python scripts/pilot_9709.py                    # full pilot
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Allow running as a plain script from the repository root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pdf_extraction.bank.run import run_corpus  # noqa: E402

PDF_DIR = Path("pdf_extraction/my_raw_pdfs/a-level/mathematics-9709")
OUT_DIR = Path("data/bank-pilot-9709")
SUBJECT_CONTEXT = "CAIE A-Level Mathematics 9709"

# 9709 syllabus topics, used to constrain the tagging pass to real topics.
SUBJECT_TOPICS = [
    "Quadratics", "Functions", "Coordinate geometry", "Circular measure",
    "Trigonometry", "Series", "Differentiation", "Integration",
    "Algebra", "Logarithmic and exponential functions",
    "Trigonometry (advanced)", "Differentiation (advanced)",
    "Integration (advanced)", "Numerical solution of equations", "Vectors",
    "Differential equations", "Complex numbers",
    "Forces and equilibrium", "Kinematics of motion in a straight line",
    "Momentum", "Newton's laws of motion", "Energy, work and power",
    "Representation of data", "Permutations and combinations", "Probability",
    "Discrete random variables", "The normal distribution",
    "The Poisson distribution", "Linear combinations of random variables",
    "Continuous random variables", "Sampling and estimation",
    "Hypothesis tests",
]


def discover(years: range, limit: int | None, doc_types: set[str]) -> list[Path]:
    """Find 9709 papers for the requested years."""
    if not PDF_DIR.is_dir():
        return []

    found: list[Path] = []
    for pdf in sorted(PDF_DIR.glob("9709_*.pdf")):
        parts = pdf.stem.split("_")
        if len(parts) < 4:
            continue
        session_year, doc_type = parts[1], parts[2]
        if doc_type not in doc_types:
            continue
        if len(session_year) < 3 or session_year[0] not in "swm":
            continue
        try:
            year = 2000 + int(session_year[1:3])
        except ValueError:
            continue
        if year in years:
            found.append(pdf)

    return found[:limit] if limit else found


def main() -> int:
    parser = argparse.ArgumentParser(description="CAIE 9709 pilot run")
    parser.add_argument("--from-year", type=int, default=2021)
    parser.add_argument("--to-year", type=int, default=2025)
    parser.add_argument("--limit", type=int, help="cap on number of documents")
    parser.add_argument(
        "--max-questions", type=int,
        help="cap on questions per document, to bound spend",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="run the free stages only; no model calls and no cost",
    )
    parser.add_argument(
        "--no-tagging", action="store_true",
        help="skip the DeepSeek tagging and difficulty pass",
    )
    parser.add_argument(
        "--doc-types", default="qp,ms",
        help="comma-separated document types to include (default qp,ms)",
    )
    parser.add_argument(
        "--concurrency", type=int, default=8,
        help="parallel model calls; raise until the provider rate-limits",
    )
    parser.add_argument("--out", type=Path, default=OUT_DIR)
    args = parser.parse_args()

    years = range(args.from_year, args.to_year + 1)
    doc_types = {value.strip() for value in args.doc_types.split(",") if value.strip()}
    papers = discover(years, args.limit, doc_types)

    if not papers:
        print(f"No 9709 papers found under {PDF_DIR} for {args.from_year}-{args.to_year}.")
        print("Fetch them first:")
        print("  python scripts/downloader_v2_fixed.py --subject Mathematics-9709")
        return 1

    args.out.mkdir(parents=True, exist_ok=True)
    print(f"pilot: {len(papers)} documents, {args.from_year}-{args.to_year}, types={sorted(doc_types)}")
    print(f"mode:  {'stages 1-2 only (free)' if args.dry_run else 'full pipeline (billed)'}")
    print(f"out:   {args.out}\n")

    stats = run_corpus(
        papers,
        db_path=args.out / "bank.db",
        asset_root=args.out / "assets",
        use_model=not args.dry_run,
        do_tagging=not args.no_tagging,
        subject_topics=SUBJECT_TOPICS,
        subject_context=SUBJECT_CONTEXT,
        max_questions_per_doc=args.max_questions,
        concurrency=args.concurrency,
    )

    report = stats.to_dict()
    report_path = args.out / "pilot-report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print("\n" + "=" * 56)
    print(f"documents      {stats.documents} ok, {stats.documents_failed} failed")
    print(f"questions      {stats.questions}")
    print(f"mark schemes   {stats.mark_schemes}")
    print(f"answer keys    {stats.answer_keys}")
    print(f"assets         {stats.assets}")
    print(f"needs review   {stats.needs_review} ({stats.flags} flags)")
    print(f"skipped        {stats.skipped_cached} (already in ledger)")
    print(f"cost           ${stats.cost_usd:.4f}  (${stats.cost_per_question:.5f}/question)")
    print(f"elapsed        {stats.seconds:.0f}s  ({stats.billed_items/max(stats.seconds,1)*3600:,.0f} items/h)")
    print("=" * 56)
    print(f"report -> {report_path}")

    return 0 if stats.documents_failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
