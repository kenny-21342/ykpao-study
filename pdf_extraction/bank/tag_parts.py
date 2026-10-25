"""Tag and rate each sub-part of a multi-part question.

The question-level pass (``tag.py``) gives one topic set and one difficulty per
question, so "Question 7, 12 marks" is a single 3 even when part (a) is a
recall and part (d) is an extension. This pass reads the same transcribed text
once and rates every part, which is what filtering "hard questions about
circular motion" at part level needs.

One call per question, not one per part: the parts share a stem and a figure,
so separate calls would pay for the stem repeatedly and rate each part blind
to its neighbours.

Only questions with two or more parts are sent (see ``parts.py``): about 22,300
of the ~72,000. A single-part question's tags already describe it.

    python3 -m pdf_extraction.bank.tag_parts --sample 300            # dry run
    python3 -m pdf_extraction.bank.tag_parts --sample 300 --apply    # CALIBRATION, spends ~cents
    python3 -m pdf_extraction.bank.tag_parts --apply --max-spend 25  # the full run

Without ``--apply`` nothing is called. Results land in the local
``bank_question_parts`` table; ``scripts/apply-parts.mjs`` pushes them.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from . import store
from .client import CallResult, ProviderError, call_json
from .env import text_settings
from .parts import parts_for_question
from .qa import RunLedger, create_ledger_key
from .run import TEXT_INPUT_PER_MTOK, TEXT_OUTPUT_PER_MTOK
from .tag import DIFFICULTY_RUBRIC
from .tag_corpus import COOLDOWN_GIVE_UP_AFTER, COOLDOWN_WAITS, _is_cooldown
from .topics import syllabus_for

ROOT = Path(__file__).resolve().parent
DB = ROOT / "extract.db"
PROMPT_VERSION = "v1-parts-1"
STAGE = "tagpart"

SCHEMA = """
CREATE TABLE IF NOT EXISTS bank_question_parts (
    question_id    INTEGER NOT NULL REFERENCES bank_questions(id) ON DELETE CASCADE,
    label          TEXT NOT NULL,
    ordering       INTEGER NOT NULL,
    marks          INTEGER,
    topic          TEXT,
    difficulty     INTEGER,
    rationale      TEXT,
    model          TEXT,
    prompt_version TEXT,
    PRIMARY KEY (question_id, label)
);
"""

_SYSTEM_PROMPT = f"""\
You classify the sub-parts of one past-paper examination question. You never answer them.

You are given the question text, the labels of its parts (for example "a",
"b(i)"), and, for each, the marks when known. Rate EACH listed part separately.

DIFFICULTY RUBRIC — apply exactly, and judge the work required of a candidate
for that part alone, not the whole question:
{DIFFICULTY_RUBRIC}

RULES
1. Return one entry per listed label, in the same order, copying each label
   verbatim. Never add, drop or rename a label.
2. topic: the single best match from the supplied syllabus topic list, copied
   verbatim, or "" if the list is empty or nothing fits.
3. difficulty: integer 1-5.
4. rationale: one short sentence naming what sets the level of that part.

Return a single JSON object with exactly this shape and nothing else:
{{"parts":[{{"label":"a","topic":"","difficulty":2,"rationale":""}}]}}
"""


def build_user_text(body_md: str, parts: list[dict[str, Any]], topics: list[str], context: str | None) -> str:
    return json.dumps(
        {
            "subject_context": context or "unspecified",
            "syllabus_topics": topics,
            "parts": [{"label": p["label"], "marks": p.get("marks")} for p in parts],
            "question_text": body_md.strip(),
        },
        ensure_ascii=True,
        separators=(",", ":"),
    )


def parse_response(content: dict[str, Any], parts: list[dict[str, Any]], topics: list[str]) -> list[dict[str, Any]]:
    """Keep only what the prompt licensed: known labels, listed topics, 1-5."""
    allowed = {t.casefold(): t for t in topics}
    by_label: dict[str, dict[str, Any]] = {}
    for entry in content.get("parts") or []:
        if isinstance(entry, dict) and str(entry.get("label", "")).strip():
            by_label.setdefault(str(entry["label"]).strip(), entry)
    out = []
    for order, part in enumerate(parts):
        entry = by_label.get(part["label"])
        if entry is None:
            continue
        try:
            difficulty = max(1, min(5, int(entry.get("difficulty"))))
        except (TypeError, ValueError):
            continue
        out.append({
            "label": part["label"],
            "ordering": order,
            "marks": part.get("marks"),
            "topic": allowed.get(str(entry.get("topic", "")).strip().casefold()),
            "difficulty": difficulty,
            "rationale": str(entry.get("rationale", "") or "").strip()[:300],
        })
    return out


def _validate(payload: dict[str, Any]) -> None:
    if not isinstance(payload, dict) or not isinstance(payload.get("parts"), list) or not payload["parts"]:
        raise ProviderError("response has no parts list")


def tag_parts(
    body_md: str,
    parts: list[dict[str, Any]],
    topics: list[str],
    context: str | None,
    *,
    settings: dict[str, Any],
) -> tuple[list[dict[str, Any]], CallResult]:
    result = call_json(
        endpoint=settings["endpoint"],
        api_key=settings["api_key"],
        model=settings["model"],
        system_prompt=_SYSTEM_PROMPT,
        user_text=build_user_text(body_md, parts, topics, context),
        image_paths=None,
        validator=_validate,
        max_attempts=settings.get("max_attempts", 3),
        timeout_seconds=settings.get("timeout_seconds", 180),
        artifact_dir=None,
    )
    return parse_response(result.content, parts, topics), result


def pending(connection: sqlite3.Connection, subject: str | None) -> list[dict[str, Any]]:
    sql = """
        SELECT q.id AS question_id, q.paper_id, q.root_number, q.body_md, q.parts,
               p.source_sha256, s.code AS subject_code, p.year AS paper_year, s.level AS subject_level
        FROM bank_questions q
        JOIN bank_papers p ON p.id = q.paper_id
        JOIN bank_subjects s ON s.id = p.subject_id
        WHERE q.status = 'published' AND COALESCE(q.body_md, '') <> '' AND p.doc_type = 'qp'
    """
    args: list[str] = []
    if subject:
        sql += " AND lower(s.code) = lower(?)"
        args.append(subject)
    sql += " ORDER BY s.code, q.paper_id, q.root_number"
    rows = []
    for row in connection.execute(sql, args).fetchall():
        parts = parts_for_question(row["parts"], row["body_md"])
        if parts:
            rows.append({**dict(row), "part_list": parts})
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--subject", default=None)
    parser.add_argument("--apply", action="store_true", help="make the calls. THIS SPENDS MONEY.")
    parser.add_argument("--sample", type=int, default=0,
                        help="a fixed spread of this many questions across subjects (for calibration)")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--concurrency", type=int, default=12)
    parser.add_argument("--max-spend", type=float, default=25.0)
    args = parser.parse_args()

    settings = text_settings()
    model = settings["model"]
    connection = store.connect(DB)
    connection.executescript(SCHEMA)
    connection.execute("PRAGMA busy_timeout = 30000")
    ledger = RunLedger(connection=connection)

    work = []
    skipped_no_topics = 0
    already = 0
    for row in pending(connection, args.subject):
        found = syllabus_for(row["subject_code"], row["paper_year"], row["subject_level"])
        topics, context = (found.topics, found.context) if found else ([], None)
        # A list narrowed to an era or level is a different prompt: tag it again.
        version = f"{PROMPT_VERSION}:{found.variant}" if found and found.variant else PROMPT_VERSION
        row["version"] = version
        key = create_ledger_key(row["source_sha256"], row["root_number"], model, version, STAGE)
        if ledger.is_completed(key):
            already += 1
            continue
        if not found:
            skipped_no_topics += 1  # still tagged: difficulty is useful without a topic
        work.append((row, topics, context, key))

    if args.sample:
        # Stable spread: order by a hash of the id, so a re-run picks the same
        # questions and the numbers are comparable.
        work.sort(key=lambda w: hashlib.sha256(str(w[0]["question_id"]).encode()).hexdigest())
        work = work[: args.sample]
    elif args.limit:
        work = work[: args.limit]

    print(f"{len(work)} multi-part questions to tag ({already} already done; "
          f"{skipped_no_topics} are in subjects with no syllabus topics: difficulty only)")
    if not args.apply:
        chars = sum(len(w[0]["body_md"]) for w in work)
        est_in = (chars / 3 + 900 * len(work)) / 1e6
        print(f"rough input estimate: {est_in:.1f}M tokens -> ${est_in * TEXT_INPUT_PER_MTOK:.2f} in, "
              f"plus output. Dry run: nothing was called. Re-run with --apply.")
        connection.close()
        return 0
    if not work:
        connection.close()
        return 0

    print(f"model: {model}   workers: {args.concurrency}   cap: ${args.max_spend:.2f}")
    started = time.time()
    spend = 0.0
    done = failed = parts_written = tokens_in = tokens_out = 0
    reasons: dict[str, int] = {}

    def call(entry):
        row, topics, context, _key = entry
        return tag_parts(row["body_md"], row["part_list"], topics, context, settings=settings)

    window = max(args.concurrency * 4, 8)
    queue = list(work)
    cooldowns = 0
    stop = False
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        while queue and not stop:
            batch, queue = queue[:window], queue[window:]
            throttled = []
            for entry, future in [(e, pool.submit(call, e)) for e in batch]:
                row, _topics, _context, key = entry
                try:
                    results, call_result = future.result()
                except Exception as error:  # noqa: BLE001
                    if _is_cooldown(error):
                        throttled.append(entry)
                        continue
                    failed += 1
                    reason = str(error)[:120]
                    if reason not in reasons:
                        print(f"  ! {reason}", flush=True)
                    reasons[reason] = reasons.get(reason, 0) + 1
                    ledger.record_failure(key, STAGE, row["source_sha256"], row["root_number"], str(error)[:300])
                    connection.commit()
                    continue
                if not results:
                    failed += 1
                    ledger.record_failure(key, STAGE, row["source_sha256"], row["root_number"],
                                          "no usable parts in the reply")
                    connection.commit()
                    continue
                connection.execute("DELETE FROM bank_question_parts WHERE question_id = ?", (row["question_id"],))
                connection.executemany(
                    "INSERT INTO bank_question_parts (question_id, label, ordering, marks, topic, "
                    "difficulty, rationale, model, prompt_version) VALUES (?,?,?,?,?,?,?,?,?)",
                    [(row["question_id"], r["label"], r["ordering"], r["marks"], r["topic"],
                      r["difficulty"], r["rationale"], model, row["version"]) for r in results],
                )
                ledger.record_success(key, STAGE, row["source_sha256"], row["root_number"],
                                      call_result.input_tokens or 0, call_result.output_tokens or 0)
                connection.commit()
                done += 1
                parts_written += len(results)
                tokens_in += call_result.input_tokens or 0
                tokens_out += call_result.output_tokens or 0
                spend += (call_result.input_tokens / 1e6 * TEXT_INPUT_PER_MTOK
                          + call_result.output_tokens / 1e6 * TEXT_OUTPUT_PER_MTOK)
                if done % 50 == 0:
                    rate = done / max(time.time() - started, 1) * 3600
                    print(f"  {done}/{len(work)}  ${spend:.2f}  {rate:,.0f}/h  {failed} failed", flush=True)
                if spend >= args.max_spend:
                    print(f"  spend cap ${args.max_spend:.2f} reached - stopping", flush=True)
                    stop = True
                    break
            if stop:
                break
            if not throttled:
                cooldowns = 0
                continue
            queue = throttled + queue
            if cooldowns >= COOLDOWN_GIVE_UP_AFTER:
                print(f"  provider still cooling down - stopping with {len(queue):,} left; re-run to resume", flush=True)
                break
            wait = COOLDOWN_WAITS[cooldowns]
            cooldowns += 1
            print(f"  provider cooling down ({len(throttled)} held) - waiting {wait / 60:.0f} min", flush=True)
            time.sleep(wait)

    connection.close()
    minutes = (time.time() - started) / 60
    print(f"\ndone in {minutes:.1f} min: {done} questions, {parts_written} parts, {failed} failed, ${spend:.2f}")
    if done:
        per_q = spend / done
        print(f"measured: {tokens_in / done:.0f} tokens in + {tokens_out / done:.0f} out per question, "
              f"${per_q:.4f}/question, {parts_written / done:.1f} parts each")
        total = len(pending(store.connect(DB), args.subject))
        print(f"projected for all {total:,} multi-part questions: ${per_q * total:.2f}")
    for reason, count in sorted(reasons.items(), key=lambda kv: -kv[1])[:5]:
        print(f"  {count:>6}  {reason}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
