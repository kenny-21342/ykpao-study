#!/usr/bin/env python3
"""Crop the whole corpus. No model calls, no spend.

    python3 -m pdf_extraction.bank.corpus_run

Resumable: bank_papers is keyed on source_path, so a re-run updates rather
than duplicates, and anything already done is cheap to pass over again.
"""
from __future__ import annotations

import sqlite3
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


def already_done() -> set[str]:
    """Source paths already cropped, so a restart does not redo them.

    Each document commits as it finishes, so an interrupted run keeps
    everything it had written — but re-rendering those papers costs the same
    as the first time. Rendering is deterministic, so a paper whose recorded
    page count is non-zero has nothing left to gain from a second pass.
    """
    if not DB.exists():
        return set()
    connection = sqlite3.connect(DB)
    try:
        rows = connection.execute(
            "SELECT source_path FROM bank_papers WHERE page_count > 0"
        ).fetchall()
    except sqlite3.OperationalError:
        return set()          # schema not created yet
    finally:
        connection.close()
    return {row[0] for row in rows}


def main() -> int:
    papers = collect()
    total = len(papers)

    done = already_done()
    if done:
        # Stored paths are relative to the repository root.
        repo = ROOT.parent
        papers = [
            path for path in papers
            if str(path.relative_to(repo)) not in done and str(path) not in done
        ]
        print(f"resuming: {total - len(papers)} of {total} already cropped",
              flush=True)

    # The argument is a chunk size, applied *after* the resume filter, so
    # repeated bounded runs walk the corpus. Long single runs have twice been
    # killed part way through; each chunk that finishes is progress that the
    # next one skips.
    chunk = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    if chunk:
        papers = papers[:chunk]

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
