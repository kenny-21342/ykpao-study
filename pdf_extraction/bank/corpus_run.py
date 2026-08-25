#!/usr/bin/env python3
"""Crop the whole corpus. No model calls, no spend.

    python3 -m pdf_extraction.bank.corpus_run

Resumable: bank_papers is keyed on source_path, so a re-run updates rather
than duplicates, and anything already done is cheap to pass over again.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from .run import run_corpus

ROOT = Path(__file__).resolve().parent.parent
DB = Path(__file__).resolve().parent / "extract.db"
ASSETS = Path(__file__).resolve().parent / "assets"


def collect() -> list[Path]:
    papers = sorted((ROOT / "my_raw_pdfs").rglob("*.pdf"))
    papers += sorted((ROOT / "IB PAST PAPERS - YEAR").rglob("*.pdf"))
    return papers


def main() -> int:
    papers = collect()
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    if limit:
        papers = papers[:limit]

    started = time.time()
    print(f"{len(papers)} documents -> {DB}", flush=True)

    def log(message: str) -> None:
        print(f"[{time.time() - started:8.0f}s] {message}", flush=True)

    stats = run_corpus(
        papers,
        db_path=DB,
        asset_root=ASSETS,
        use_model=False,
        progress_every=100,
        log=log,
    )

    print(
        f"\ndone in {stats.seconds / 60:.1f} min: "
        f"{stats.questions} questions, {stats.mark_schemes} mark schemes, "
        f"{stats.assets} assets, {stats.flags} flags, {len(stats.errors)} errors",
        flush=True,
    )
    for error in stats.errors[:20]:
        print(f"  ! {error.get('file')}: {str(error.get('error'))[:100]}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
