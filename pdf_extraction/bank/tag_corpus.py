"""Stage 4 on its own — tag and rate what is already transcribed.

`corpus_run --use-model` can tag, but it reaches a question by preparing the
document it came from: stage 1 re-detects spans and stage 2 re-renders the
crops, because that is how it learns the `source_sha256` the ledger is keyed
on. For a transcription run that is the price of admission. For a *tagging*
run it is pure waste -- the text the tagger needs is already in the store, and
`source_sha256` is a column on `bank_papers`.

Measured on 26 Sep 2026, after transcription finished: preparation cost about
30 seconds a paper, so tagging the 6,745 remaining question papers through
`corpus_run` would have spent roughly **56 hours** of single-threaded local CPU
to make about $49 of API calls. This script opens no PDF at all.

It is deliberately narrow. It never writes `body_md`, `status`, or the
run/model/prompt columns -- `store.update_question_tagging` exists for exactly
that reason -- so a tagging pass cannot damage a transcription.

    python3 -m pdf_extraction.bank.tag_corpus --subject 0625 --limit 50
    python3 -m pdf_extraction.bank.tag_corpus --apply --max-spend 60

Without `--apply` it reports what it would do and calls nothing.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import store
from .env import text_settings
from .qa import RunLedger, create_ledger_key
from .run import TEXT_INPUT_PER_MTOK, TEXT_OUTPUT_PER_MTOK
from .tag import PROMPT_VERSION as TAG_PROMPT_VERSION
from .tag import tag_and_rate
from .topics import configured_subjects, topics_for

ROOT = Path(__file__).resolve().parent
DB = ROOT / "extract.db"


def pending_rows(connection: sqlite3.Connection, subject: str | None) -> list[sqlite3.Row]:
    """Published, transcribed questions with no successful tag ledger row.

    The ledger key includes the model and prompt version, so changing either
    re-tags rather than silently reusing a rating made under different rules.
    That is also why the anti-join is on the key and not merely on
    `(source_sha256, root_number)`.
    """
    sql = """
        SELECT q.id AS question_id, q.paper_id, q.root_number, q.body_md,
               p.source_sha256, s.code AS subject_code
        FROM bank_questions q
        JOIN bank_papers p ON p.id = q.paper_id
        JOIN bank_subjects s ON s.id = p.subject_id
        WHERE q.status = 'published'
          AND COALESCE(q.body_md, '') <> ''
          AND p.doc_type = 'qp'
    """
    params: list[str] = []
    if subject:
        sql += " AND lower(s.code) = lower(?)"
        params.append(subject)
    sql += " ORDER BY s.code, q.paper_id, q.root_number"
    return connection.execute(sql, params).fetchall()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--subject", default=None, help="syllabus code, e.g. 0625")
    parser.add_argument("--apply", action="store_true", help="make the calls. THIS SPENDS MONEY.")
    parser.add_argument("--limit", type=int, default=0, help="stop after this many questions")
    parser.add_argument("--concurrency", type=int, default=12)
    parser.add_argument("--max-spend", type=float, default=60.0)
    parser.add_argument("--allow-untagged-topics", action="store_true",
                        help="tag subjects with no syllabus topics (no topics will be written)")
    args = parser.parse_args()

    if not DB.exists():
        print(f"no store at {DB}", file=sys.stderr)
        return 1

    # Resolved even for a dry run: the ledger key includes the model name, so
    # without it the dry run cannot tell what is already tagged and reports the
    # whole subject as outstanding.
    settings = text_settings()
    model = settings["model"]

    connection = store.connect(DB)
    connection.execute("PRAGMA busy_timeout = 30000")
    ledger = RunLedger(connection=connection)

    rows = pending_rows(connection, args.subject)
    # Group by subject so the syllabus topic list is loaded once, and so a
    # subject with none configured can be refused as a whole rather than
    # billed question by question for topics that will all be discarded.
    by_subject: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        by_subject.setdefault(row["subject_code"] or "", []).append(row)

    work: list[tuple[sqlite3.Row, list[str] | None, str | None]] = []
    skipped_subjects: list[tuple[str, int]] = []
    already = 0
    for code, subject_rows in sorted(by_subject.items(), key=lambda kv: -len(kv[1])):
        found = topics_for(code)
        if not found and not args.allow_untagged_topics:
            skipped_subjects.append((code, len(subject_rows)))
            continue
        topics, context = found if found else (None, None)
        for row in subject_rows:
            key = create_ledger_key(row["source_sha256"], row["root_number"],
                                    model, TAG_PROMPT_VERSION, "tag")
            if ledger.is_completed(key):
                already += 1
                continue
            work.append((row, topics, context))

    if args.limit:
        work = work[: args.limit]

    print(f"{len(rows)} published transcribed questions"
          + (f" in {args.subject}" if args.subject else ""))
    if already:
        print(f"  {already} already tagged by this model+prompt — skipping")
    if skipped_subjects:
        total = sum(n for _, n in skipped_subjects)
        names = ", ".join(f"{c or '(blank)'}:{n}" for c, n in skipped_subjects[:8])
        print(f"  {total} skipped — no syllabus topics configured ({names})")
        print(f"     configured: {len(configured_subjects())} subjects; "
              f"pass --allow-untagged-topics to tag them without topics")
    print(f"  {len(work)} to tag now")

    if not args.apply:
        print("\nDry run. Nothing was called. Re-run with --apply.")
        connection.close()
        return 0
    if not work:
        connection.close()
        return 0

    print(f"\nmodel: {model} @ {settings['endpoint']}")
    print(f"workers: {args.concurrency}   cap: ${args.max_spend:.2f}")
    started = time.time()
    spend = 0.0
    done = failed = 0

    def call(entry):
        row, topics, context = entry
        return row, tag_and_rate(row["body_md"], topics, context, settings=settings)

    # Writes stay on this thread: SQLite takes one writer, and the ledger
    # shares this connection so a failure rolls back with the row it belongs to.
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        for entry, future in [(e, pool.submit(call, e)) for e in work]:
            row = entry[0]
            try:
                _row, (tagging, call_result) = future.result()
            except Exception as error:  # noqa: BLE001 — one bad question is not the run
                failed += 1
                ledger.record_failure(
                    create_ledger_key(row["source_sha256"], row["root_number"],
                                      model, TAG_PROMPT_VERSION, "tag"),
                    "tag", row["source_sha256"], row["root_number"], str(error)[:300])
                connection.commit()
                continue
            store.update_question_tagging(connection, paper_id=row["paper_id"],
                                          root_number=row["root_number"], tagging=tagging)
            ledger.record_success(
                create_ledger_key(row["source_sha256"], row["root_number"],
                                  model, TAG_PROMPT_VERSION, "tag"),
                "tag", row["source_sha256"], row["root_number"],
                getattr(call_result, "input_tokens", 0) or 0,
                getattr(call_result, "output_tokens", 0) or 0)
            connection.commit()
            done += 1
            # `CallResult` carries token counts and no price, so the cap has to
            # be computed here. Reading a `cost_usd` attribute off it silently
            # yielded 0.00 for every call, which meant --max-spend was not a
            # limit at all -- the run would have gone to completion whatever
            # the cap said. Same constants the pipeline bills with.
            spend += (call_result.input_tokens / 1e6 * TEXT_INPUT_PER_MTOK
                      + call_result.output_tokens / 1e6 * TEXT_OUTPUT_PER_MTOK)
            if done % 50 == 0:
                rate = done / max(time.time() - started, 1) * 3600
                print(f"  {done}/{len(work)}  ${spend:.2f}  {rate:,.0f}/h  {failed} failed",
                      flush=True)
            if spend >= args.max_spend:
                print(f"  spend cap ${args.max_spend:.2f} reached — stopping", flush=True)
                break

    connection.close()
    mins = (time.time() - started) / 60
    print(f"\ndone in {mins:.1f} min: {done} tagged, {failed} failed, ${spend:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
