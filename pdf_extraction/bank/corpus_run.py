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
from .topics import configured_subjects, topics_for

ROOT = Path(__file__).resolve().parent.parent
DB = Path(__file__).resolve().parent / "extract.db"
ASSETS = Path(__file__).resolve().parent / "assets"


_SEPARATORS = re.compile(r"[-_\s]+")


def _slug(text: str) -> str:
    """Normalise a subject name so hyphens, underscores and spaces agree."""
    return _SEPARATORS.sub("-", text.strip().lower()).strip("-")


def matches_subject(path: Path, subject: str) -> bool:
    """Whether a PDF belongs to the named syllabus code or IB subject.

    CAIE papers live under my_raw_pdfs/<level>/<name>-<code>/ and name their
    code in the filename too (0625_s23_qp_41.pdf). IB papers are filed by
    subject *group* -- "Individuals and societies" -- and name the subject in
    the filename instead (Business_management_paper_1_HL.pdf), so the filename
    is the only place the subject appears.

    Separators have to be normalised on both sides. The subject slugs use
    hyphens and the IB filenames use underscores, so matching them literally
    silently returned nothing for every multi-word subject while single-word
    ones worked -- the failure looks like a missing subject, not a bug.

    Where a filename carries a paper marker the subject is everything before
    it, and the match must be exact: `mathematics` is a different subject from
    `mathematics-analysis-and-approaches`, and a prefix test quietly swallows
    the second into the first. CAIE filenames have no such marker, so they
    keep the prefix test.
    """
    wanted = _slug(subject)
    name = _slug(path.stem)

    # An IB filename names its own subject, so it decides on its own. Asking
    # the directory first gets this wrong: the group directory is
    # "Group 5 - Mathematics", which ends with "-mathematics", so the subject
    # `mathematics` claimed analysis-and-approaches,
    # applications-and-interpretation, mathematical-studies and
    # further-mathematics as well -- 602 papers where 176 belong.
    if "-paper-" in name:
        return name.split("-paper-", 1)[0] == wanted

    for part in path.parts:
        slug = _slug(part)
        if slug == wanted or slug.endswith(f"-{wanted}"):
            return True
    return name.startswith(f"{wanted}-")


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


# The day the prose detector stopped turning a rubric's "score 0" into a
# question. A root-0 transcription recorded on or after this date was produced
# by the corrected detector, so the paper does not need revisiting again.
# Moving this date forward re-opens the revisit for one more pass; it is the
# only knob that can cause those papers to be transcribed again.
PROSE_DETECTOR_FIXED_AT = "2026-09-23"


def tagged() -> set[str]:
    """Source paths whose every question already has an `ok` tag ledger row.

    The resume filter for a model run asks whether a paper is *transcribed*.
    Once transcription finished that became the wrong question for a second
    time -- the same shape as the `already_done` trap described below, where a
    filter that was right for the previous stage silently skips the whole
    corpus for the next one. With 14,172 of 14,194 papers transcribed, a
    tagging pass filtered by `transcribed()` alone selects nothing at all and
    reports success having done no work.

    Intersecting this with `transcribed()` is what makes a paper "done": both
    stages have their own ledger key precisely so tagging can run later over
    what is already transcribed, and `run.py` then queues those questions with
    `needs_transcribe=False`, reusing the stored text so no vision call is
    repeated.

    Only question papers are tagged -- a mark scheme has no topics -- so any
    other `doc_type` is tagged on its own terms, as is a question paper the
    segmenter found no questions in.
    """
    if not DB.exists():
        return set()
    connection = sqlite3.connect(DB)
    try:
        rows = connection.execute(
            """
            WITH tag_ok AS (
                SELECT source_sha256, COUNT(DISTINCT root_number) AS done
                FROM bank_run_ledger
                WHERE stage = 'tag' AND status = 'ok'
                GROUP BY source_sha256
            )
            SELECT p.source_path,
                   p.doc_type,
                   (SELECT COUNT(*) FROM bank_questions q WHERE q.paper_id = p.id) AS questions,
                   COALESCE(t.done, 0) AS done
            FROM bank_papers p
            LEFT JOIN tag_ok t ON t.source_sha256 = p.source_sha256
            """
        ).fetchall()
    except sqlite3.OperationalError:
        return set()
    finally:
        connection.close()

    finished = set()
    for source_path, doc_type, questions, done in rows:
        if doc_type != "qp" or questions == 0 or done >= questions:
            finished.add(source_path)
    return finished


def transcribed() -> set[str]:
    """Source paths whose every billable item is already transcribed.

    A model run cannot use `already_done`, which asks whether a paper has been
    *cropped* -- every paper has, so it would skip the corpus. The ledger does
    the resuming instead, but only for the model calls: phase A still
    re-segments and re-renders every paper it is given before phase B makes its
    first call unless --stream-model-work is enabled. For the whole corpus that
    is about nine hours of work, and a
    hundred and forty thousand rendered spans held in memory, before a single
    question is transcribed.

    `--chunk` exists for exactly that, and did not work here: with the resume
    filter switched off, every chunk took the same first N papers and the run
    could never reach paper N+1. So a long transcription run had to be one
    process or nothing.

    A paper is finished when every billable root has an `ok` ledger row.
    Earlier runs marked roots above the provider's image limit as `skipped`;
    chunked transcription can now process them, so those rows must remain
    eligible on resume. A multiple-choice mark scheme has no model work: stage
    1 recovers its answer key, so it counts as finished on its own terms.
    """
    if not DB.exists():
        return set()
    connection = sqlite3.connect(DB)
    try:
        rows = connection.execute(
            """
            WITH successful AS (
                SELECT source_sha256, COUNT(DISTINCT root_number) AS done
                FROM bank_run_ledger
                WHERE stage = 'transcribe' AND status = 'ok'
                GROUP BY source_sha256
            ),
            -- A root-0 transcription recorded after the prose detector was
            -- fixed: proof the revisit below has already been carried out.
            revisited AS (
                SELECT DISTINCT source_sha256
                FROM bank_run_ledger
                WHERE stage = 'transcribe' AND status = 'ok'
                  AND root_number = 0
                  AND completed_at >= 'PROSE_DETECTOR_FIXED_AT'
            )
            SELECT p.source_path,
                   (SELECT COUNT(*) FROM bank_questions q WHERE q.paper_id = p.id)
                 + (SELECT COUNT(*) FROM bank_mark_schemes m
                      WHERE m.paper_id = p.id
                        AND COALESCE(m.answer_letter, '') = '')       AS needed,
                   (SELECT COUNT(*) FROM bank_mark_schemes m WHERE m.paper_id = p.id)
                                                                       AS schemes,
                   p.doc_type                                          AS doc_type,
                   p.span_strategy                                     AS span_strategy,
                   (SELECT COUNT(*) FROM bank_mark_schemes m
                      WHERE m.paper_id = p.id AND m.root_number = 0)   AS zero_roots,
                   p.page_count                                        AS pages,
                   COALESCE(s.done, 0)                                AS done,
                   (r.source_sha256 IS NOT NULL)                       AS revisited
            FROM bank_papers p
            LEFT JOIN successful s ON s.source_sha256 = p.source_sha256
            LEFT JOIN revisited  r ON r.source_sha256 = p.source_sha256
            """.replace("PROSE_DETECTOR_FIXED_AT", PROSE_DETECTOR_FIXED_AT)
        ).fetchall()
    except sqlite3.OperationalError:
        return set()
    finally:
        connection.close()

    reprocessed = {row[0]: bool(row[-1]) for row in rows}
    finished = set()
    for source_path, needed, schemes, doc_type, strategy, zero_roots, pages, done, _rev in rows:
        if doc_type == "in" and pages > 0:
            finished.add(source_path)
            continue
        if (doc_type == "ms" and strategy == "prose" and zero_roots
                and "IB PAST PAPERS - YEAR" in source_path
                and not reprocessed.get(source_path)):
            # The old prose detector made rubric score 0 into a question.
            # Revisit even papers whose wrong roots were marked successful --
            # but only until they have actually been revisited.
            #
            # Without that second condition this never terminates. Re-running
            # a paper does not clear its root 0, so the same predicate matches
            # again on the next pass, `discard` fires again, and the chunk
            # loop rebuilds the identical set forever. On 25 Sep that is what
            # the corpus run did at 99.85%: 16 consecutive chunks over the
            # same 22 papers, each logging "chunk finished cleanly" while the
            # ledger stayed frozen, re-rendering them every three minutes.
            #
            # `reprocessed` is the bound: a root-0 success recorded after the
            # detector was fixed is the evidence that the revisit has already
            # happened. A paper whose only root-0 success predates the fix is
            # still revisited exactly once, and its new ledger row then ends
            # the revisit. Nothing is re-transcribed that the old rule would
            # have left alone, so this cannot increase spend.
            finished.discard(source_path)
            continue
        if needed == 0 and schemes > 0:
            finished.add(source_path)        # an answer key: nothing to bill
        elif needed == 0 and pages > 0:
            # Rendered, and it yielded nothing to transcribe: an insert or
            # resource booklet, or a mark scheme whose layout defeated the
            # segmenter. Neither branch above admitted these, so all 482 of
            # them stayed "remaining" forever and were re-rendered by every
            # chunk. That is what stalled the run on 19 Sep: chunks kept paying
            # eight minutes of phase A to prepare 300 documents and queue four
            # items, and papers completed per hour fell from 115 to 20 while
            # 81,586 real items waited behind them.
            #
            # `pages > 0` is what makes this safe. It means the paper has been
            # through the renderer, and rendering is deterministic, so a second
            # pass finds the same nothing -- the same reasoning `already_done`
            # uses. A paper that has never been rendered has pages = 0 and is
            # still correctly pending.
            finished.add(source_path)
        elif needed > 0 and done >= needed:
            finished.add(source_path)
    return finished


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
    parser.add_argument("--use-model", action="store_true",
                        help="transcribe the crops. THIS SPENDS MONEY.")
    parser.add_argument("--max-spend", type=float, default=100.0,
                        help="stop once a run has cost this much (default 100)")
    parser.add_argument("--concurrency", type=int, default=None,
                        help="parallel model calls (default 10; higher can be slower)")
    parser.add_argument("--stream-model-work", action="store_true",
                        help="submit and save each paper's model work while preparing the next")
    parser.add_argument("--resume-across-models", action="store_true",
                        help="keep successful transcriptions when changing vision model")
    parser.add_argument("--no-tagging", action="store_true",
                        help="transcribe only; skip the topic/difficulty pass")
    parser.add_argument("--allow-untagged-topics", action="store_true",
                        help="tag even though no syllabus topics are configured "
                             "for this subject (topics will come back empty)")
    args = parser.parse_args()

    # Stage 4 discards every topic outside the supplied syllabus list, so with
    # no list it is billed for each question and writes none. That silently
    # cost the whole corpus a tagging pass and left bank_question_topics empty.
    # Refuse it rather than repeat it.
    subject_topics: list[str] | None = None
    subject_context: str | None = None
    do_tagging = not args.no_tagging
    if args.use_model and do_tagging:
        found = topics_for(args.subject)
        if found:
            subject_topics, subject_context = found
            print(f"topics: {len(subject_topics)} syllabus topics for {args.subject}",
                  flush=True)
        elif args.allow_untagged_topics:
            print("topics: none configured — tagging will return tags, skills and "
                  "difficulty, but NO topics", flush=True)
        else:
            configured = ", ".join(configured_subjects()) or "none"
            print(
                f"no syllabus topics configured for "
                f"{args.subject or '(whole corpus)'}.\n"
                f"  The tagging pass would be billed for every question and write "
                f"zero topics.\n"
                f"  Add the subject to pdf_extraction/bank/syllabus_topics.json "
                f"(configured: {configured}),\n"
                f"  or pass --no-tagging to skip it, or --allow-untagged-topics "
                f"to run it anyway.",
                flush=True,
            )
            return 1

    papers = collect(args.subject)
    total = len(papers)
    if args.subject:
        print(f"subject {args.subject}: {total} documents", flush=True)
        if not total:
            print("nothing matched — check the code or slug", flush=True)
            return 1

    # The resume filter asks whether a paper has ever been cropped. For a
    # transcription run that is the wrong question -- every paper has been --
    # and using it would skip the entire corpus. The ledger does the resuming
    # instead, per question, so re-running stages 1 and 2 is free and correct.
    if args.force:
        done = set()
    elif args.use_model:
        done = transcribed()
        if do_tagging:
            # Both stages must be done for the paper to be. Without this a
            # tagging pass over an already-transcribed corpus selects nothing.
            done &= tagged()
    else:
        done = already_done()
    if done:
        # Stored paths are relative to the repository root.
        repo = ROOT.parent
        papers = [
            path for path in papers
            if str(path.relative_to(repo)) not in done and str(path) not in done
        ]
        verb = "transcribed" if args.use_model else "cropped"
        print(f"resuming: {total - len(papers)} of {total} already {verb}",
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
        if args.use_model:
            print(f"MODEL RUN: up to ${args.max_spend:.2f}. "
                  f"Ctrl-C is safe — the ledger resumes per question.", flush=True)
        stats = run_corpus(
            papers,
            db_path=DB,
            asset_root=ASSETS,
            use_model=args.use_model,
            max_spend_usd=args.max_spend if args.use_model else None,
            do_tagging=do_tagging,
            subject_topics=subject_topics,
            subject_context=subject_context,
            stream_model_work=args.stream_model_work,
            resume_across_models=args.resume_across_models,
            progress_every=25,
            log=log,
            **({"concurrency": args.concurrency} if args.concurrency else {}),
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
