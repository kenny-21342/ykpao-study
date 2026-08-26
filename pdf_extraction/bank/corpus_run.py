#!/usr/bin/env python3
"""Crop the corpus, or one subject of it. No model calls, no spend.

    python3 -m pdf_extraction.bank.corpus_run
    python3 -m pdf_extraction.bank.corpus_run --subject 0625
    python3 -m pdf_extraction.bank.corpus_run --subject 0625 --force
    python3 -m pdf_extraction.bank.corpus_run --chunk 500

Resumable: bank_papers is keyed on source_path, so a re-run updates rather
than duplicates, and anything already done is cheap to pass over again.

--subject narrows the run to one syllabus code or IB subject slug, which is
what makes re-rendering after an extraction fix affordable: Physics 0625 is
886 papers and about half an hour, against roughly ten hours for all 14,193.

--force turns off the resume filter. That filter asks whether a paper has ever
been cropped, which is the right question for finishing an interrupted run and
the wrong one for re-rendering papers whose crops need correcting -- without
it, every already-cropped paper is skipped and the fix reaches nothing.
"""
from __future__ import annotations

import argparse
import os
import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from .run import run_corpus

ROOT = Path(__file__).resolve().parent.parent
DB = Path(__file__).resolve().parent / "extract.db"
ASSETS = Path(__file__).resolve().parent / "assets"


def matches_subject(path: Path, subject: str) -> bool:
    """Whether a PDF belongs to the named syllabus code or IB subject.

    CAIE papers live under my_raw_pdfs/<level>/<name>-<code>/ and name their
    code in the filename too (0625_s23_qp_41.pdf); IB papers sit under a
    subject directory whose name is the slug. Matching on either the directory
    or the filename covers both without a second source of truth.
    """
    wanted = subject.lower()
    if any(wanted == part.lower() or part.lower().endswith(f"-{wanted}")
           for part in path.parts):
        return True
    return bool(re.match(rf"{re.escape(wanted)}[_/]", path.name.lower()))


def collect(subject: str | None = None) -> list[Path]:
    papers = sorted((ROOT / "my_raw_pdfs").rglob("*.pdf"))
    papers += sorted((ROOT / "IB PAST PAPERS - YEAR").rglob("*.pdf"))
    if subject:
        papers = [path for path in papers if matches_subject(path, subject)]
    skip = quarantined()
    if skip:
        repo = ROOT.parent
        papers = [
            path for path in papers
            if str(path.relative_to(repo)) not in skip
        ]
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


LOCK = Path(__file__).resolve().parent / ".corpus_run.lock"
QUARANTINE = Path(__file__).resolve().parent / "quarantine.txt"


def quarantined() -> set[str]:
    """Papers that hang the renderer and must not be attempted again.

    One pathological file stops the whole corpus: every chunk starts at the
    same paper, hangs, and is killed having done nothing. The hang is inside a
    C-level PyMuPDF call, so a Python alarm cannot interrupt it — a 90 second
    SIGALRM never fired — which rules out an in-process timeout.

    Quarantining is therefore the only way past it. Each entry records the
    path; the reason belongs in the commit that added it.
    """
    if not QUARANTINE.exists():
        return set()
    return {
        line.strip()
        for line in QUARANTINE.read_text().splitlines()
        if line.strip() and not line.startswith("#")
    }


@contextmanager
def single_writer():
    """Refuse to start while another chunk is running.

    SQLite takes one writer. A second chunk started before the first finished
    lost every write it attempted — 1,489 "database is locked" errors and 44
    papers processed in twenty minutes — and the papers it failed on simply
    went back into the queue, so the damage was wasted time rather than lost
    data. Checking the progress count is not enough: it says what has been
    written, not whether something is still writing.
    """
    if LOCK.exists():
        try:
            holder = int(LOCK.read_text().strip())
        except ValueError:
            holder = None
        if holder is not None:
            try:
                os.kill(holder, 0)      # signal 0 only tests for existence
            except ProcessLookupError:
                pass                    # stale lock from a killed run
            else:
                raise SystemExit(
                    f"another corpus run is active (pid {holder}). "
                    f"Wait for it, or remove {LOCK} if you are sure it is gone."
                )
    LOCK.write_text(str(os.getpid()))
    try:
        yield
    finally:
        LOCK.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--subject", default=None,
                        help="syllabus code (0625) or IB subject slug (biology)")
    parser.add_argument("--chunk", type=int, default=0,
                        help="stop after this many documents")
    parser.add_argument("--force", action="store_true",
                        help="re-render papers that were already cropped")
    args = parser.parse_args()

    papers = collect(args.subject)
    total = len(papers)
    if args.subject:
        print(f"subject {args.subject}: {total} documents", flush=True)
        if not total:
            print("nothing matched — check the code or slug", flush=True)
            return 1

    done = set() if args.force else already_done()
    if done:
        # Stored paths are relative to the repository root.
        repo = ROOT.parent
        papers = [
            path for path in papers
            if str(path.relative_to(repo)) not in done and str(path) not in done
        ]
        print(f"resuming: {total - len(papers)} of {total} already cropped",
              flush=True)

    # Applied *after* the resume filter, so repeated bounded runs walk the
    # corpus. Long single runs have twice been killed part way through; each
    # chunk that finishes is progress that the next one skips.
    if args.chunk:
        papers = papers[: args.chunk]

    started = time.time()
    print(f"{len(papers)} documents -> {DB}", flush=True)

    def log(message: str) -> None:
        print(f"[{time.time() - started:8.0f}s] {message}", flush=True)

    with single_writer():
        stats = run_corpus(
            papers,
            db_path=DB,
            asset_root=ASSETS,
            use_model=False,
            progress_every=25,
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
