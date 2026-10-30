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
from .client import RateLimited
from .qa import RunLedger, create_ledger_key
from .run import TEXT_INPUT_PER_MTOK, TEXT_OUTPUT_PER_MTOK
from .tag import PROMPT_VERSION as TAG_PROMPT_VERSION
from .tag import tag_and_rate
from .topics import configured_subjects, syllabus_for, topics_for

ROOT = Path(__file__).resolve().parent
DB = ROOT / "extract.db"

# How long to hold the whole run when the provider says its account pool is
# exhausted, and how far to escalate.
#
# `client.call_json` already backs off per call, but only within its three
# attempts and only by 1s then 2s when the 429 carries no `Retry-After` --
# which this provider's does not. Against a quota window measured in minutes
# that is not a retry, it is a guaranteed failure three requests deep.
#
# The first run of this script lost 4,763 questions that way on 26 Sep 2026:
# throughput fell from 10,000/h to 228/h while the failure rate reached 87%,
# and every one of those rows went into the ledger as `failed` rather than
# waiting for a window that reopens on its own. A cooldown is a property of
# the endpoint, not of a question, so it belongs to the run.
COOLDOWN_WAITS = (60.0, 120.0, 300.0, 600.0, 900.0)
COOLDOWN_GIVE_UP_AFTER = len(COOLDOWN_WAITS)


def _is_cooldown(error: BaseException) -> bool:
    """Whether this failure is the provider throttling us rather than bad input.

    `call_json` wraps the last error once its attempts run out, so the typed
    `RateLimited` is on `__cause__`. The string check is the fallback for a
    provider that reports a quota problem without the 429 that earns the type.
    """
    if isinstance(error, RateLimited) or isinstance(error.__cause__, RateLimited):
        return True
    text = str(error).lower()
    return "http 429" in text or "cooling down" in text or "rate-limited" in text


def tag_version(row) -> str:
    """The prompt version a question is tagged under.

    A list narrowed to a syllabus era or level is a different prompt, so it gets
    its own ledger key. Skipping and recording must use the same one.
    """
    found = syllabus_for(row["subject_code"], row["paper_year"], row["subject_level"])
    return f"{TAG_PROMPT_VERSION}:{found.variant}" if found and found.variant else TAG_PROMPT_VERSION


def pending_rows(connection: sqlite3.Connection, subject: str | None,
                 include_review: bool = False) -> list[sqlite3.Row]:
    """Published, transcribed questions with no successful tag ledger row.

    The ledger key includes the model and prompt version, so changing either
    re-tags rather than silently reusing a rating made under different rules.
    That is also why the anti-join is on the key and not merely on
    `(source_sha256, root_number)`.
    """
    sql = """
        SELECT q.id AS question_id, q.paper_id, q.root_number, q.body_md,
               p.source_sha256, s.code AS subject_code,
               p.year AS paper_year, s.level AS subject_level
        FROM bank_questions q
        JOIN bank_papers p ON p.id = q.paper_id
        JOIN bank_subjects s ON s.id = p.subject_id
        WHERE q.status IN ('published'{review})
          AND COALESCE(q.body_md, '') <> ''
          AND p.doc_type = 'qp'
    """.format(review=", 'needs_review'" if include_review else "")
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
    parser.add_argument("--include-review", action="store_true",
                        help="also tag questions still marked needs_review here (production may have published them)")
    parser.add_argument("--year", type=int, default=None, help="only papers from this exam year")
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

    rows = pending_rows(connection, args.subject, args.include_review)
    if args.year:
        rows = [row for row in rows if row["paper_year"] == args.year]
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
        if not topics_for(code) and not args.allow_untagged_topics:
            skipped_subjects.append((code, len(subject_rows)))
            continue
        for row in subject_rows:
            # The list that applies to this paper: its syllabus era and level.
            found = syllabus_for(code, row["paper_year"], row["subject_level"])
            topics, context = (found.topics, found.context) if found else (None, None)
            key = create_ledger_key(row["source_sha256"], row["root_number"],
                                    model, tag_version(row), "tag")
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

    def key_of(row):
        return create_ledger_key(row["source_sha256"], row["root_number"],
                                 model, tag_version(row), "tag")

    # Work is submitted a window at a time rather than all at once.
    #
    # The first version submitted every one of the 70,242 questions before
    # reading a single result. That made the spend cap decorative: `break`
    # leaves the `with` block, which shuts the pool down *waiting* for
    # everything already queued, so a cap hit at question 500 still paid for
    # the remaining 69,742. A bounded window also means a cooldown pause
    # actually stops traffic instead of draining a queue that was submitted
    # before the provider started refusing.
    window = max(args.concurrency * 4, 8)
    queue = list(work)
    requeued = 0
    cooldowns = 0
    reasons: dict[str, int] = {}
    stop = False

    # Writes stay on this thread: SQLite takes one writer, and the ledger
    # shares this connection so a failure rolls back with the row it belongs to.
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        while queue and not stop:
            batch, queue = queue[:window], queue[window:]
            throttled: list[tuple] = []
            for entry, future in [(e, pool.submit(call, e)) for e in batch]:
                row = entry[0]
                try:
                    _row, (tagging, call_result) = future.result()
                except Exception as error:  # noqa: BLE001 — one bad question is not the run
                    # A cooldown is the endpoint's state, not this question's.
                    # Put the question back and let the pause below handle it,
                    # so a quota window does not convert into thousands of
                    # permanent `failed` ledger rows.
                    if _is_cooldown(error):
                        throttled.append(entry)
                        continue
                    failed += 1
                    reason = str(error)[:120]
                    if reason not in reasons:
                        # Printed once per distinct reason. Without this the
                        # only symptom of a systemic failure was the counter
                        # climbing, which is how a 5x throughput collapse went
                        # unnoticed for two hours.
                        print(f"  ! {reason}", flush=True)
                    reasons[reason] = reasons.get(reason, 0) + 1
                    ledger.record_failure(key_of(row), "tag", row["source_sha256"],
                                          row["root_number"], str(error)[:300])
                    connection.commit()
                    continue
                store.update_question_tagging(connection, paper_id=row["paper_id"],
                                              root_number=row["root_number"], tagging=tagging)
                ledger.record_success(
                    key_of(row), "tag", row["source_sha256"], row["root_number"],
                    getattr(call_result, "input_tokens", 0) or 0,
                    getattr(call_result, "output_tokens", 0) or 0)
                connection.commit()
                done += 1
                # `CallResult` carries token counts and no price, so the cap has
                # to be computed here. Reading a `cost_usd` attribute off it
                # silently yielded 0.00 for every call, which meant --max-spend
                # was not a limit at all -- the run would have gone to
                # completion whatever the cap said. Same constants the pipeline
                # bills with.
                spend += (call_result.input_tokens / 1e6 * TEXT_INPUT_PER_MTOK
                          + call_result.output_tokens / 1e6 * TEXT_OUTPUT_PER_MTOK)
                if done % 50 == 0:
                    rate = done / max(time.time() - started, 1) * 3600
                    print(f"  {done}/{len(work)}  ${spend:.2f}  {rate:,.0f}/h  "
                          f"{failed} failed" + (f"  {requeued} requeued" if requeued else ""),
                          flush=True)
                if spend >= args.max_spend:
                    print(f"  spend cap ${args.max_spend:.2f} reached — stopping", flush=True)
                    stop = True
                    break

            if stop:
                queue = throttled + queue
                break
            if not throttled:
                cooldowns = 0
                continue

            # The window came back throttled. Wait, then retry those questions
            # ahead of the rest -- escalating, because a pool that is still
            # cooling after fifteen minutes is not going to clear in one.
            requeued += len(throttled)
            queue = throttled + queue
            if cooldowns >= COOLDOWN_GIVE_UP_AFTER:
                print(f"\n  provider still cooling down after "
                      f"{sum(COOLDOWN_WAITS) / 60:.0f} min — stopping with "
                      f"{len(queue):,} questions left. Nothing is lost: re-run "
                      f"this command and the ledger resumes from here.",
                      flush=True)
                break
            wait = COOLDOWN_WAITS[cooldowns]
            cooldowns += 1
            print(f"  provider cooling down ({len(throttled)} held) — "
                  f"waiting {wait / 60:.0f} min, then retrying them", flush=True)
            time.sleep(wait)

    connection.close()
    mins = (time.time() - started) / 60
    print(f"\ndone in {mins:.1f} min: {done} tagged, {failed} failed, ${spend:.2f}")
    if requeued:
        print(f"  {requeued} calls were held and retried through a provider cooldown")
    for reason, count in sorted(reasons.items(), key=lambda kv: -kv[1])[:5]:
        print(f"  {count:>6}  {reason}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
