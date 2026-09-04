"""Backfill syllabus topics for the whole bank, reading the source PDFs.

Usage:
    python3 scripts/backfill_topics_from_pdf.py                     # dry run + cost
    python3 scripts/backfill_topics_from_pdf.py --subject 0625
    python3 scripts/backfill_topics_from_pdf.py --subject 0625 --apply --limit 200
    python3 scripts/backfill_topics_from_pdf.py --apply --export topics.jsonl

Why this exists rather than a corpus_run stage 4.

`corpus_run` tags from `bank_questions.body_md`, and that column is empty for
66,632 of the 66,764 published questions -- the corpus is crop-only. So stage 4
has nothing to read, and the plan assumed topic tagging had to wait behind the
paid transcription pass.

It does not. The question papers are on disk with a real text layer, which is
what `skills_from_pdf` already established for command terms: a full sweep read
65,784 questions and skipped none for a missing PDF. The same slice feeds the
tagger here. Transcription is still needed for the features that show question
text to a student -- AI grading, hints, search -- but not for this.

The whitelist is the point. `tag.py::_parse_tagging_response` drops every topic
outside the supplied list, and `topics.topics_for` returns None for a subject
with no list. A subject that is not configured is therefore skipped loudly here
rather than tagged into nothing, which is the defect that cost a whole corpus
run: billed per question, zero rows written.

`--apply` writes `bank_topics` / `bank_question_topics` in the local store, the
pipeline's source of truth. `--export` also writes JSONL keyed by source path
and printed root number, because the local store and Neon number their
questions independently and that pair is the only join key meaning the same
thing on both sides.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import fitz

from pdf_extraction.bank import topics as topics_registry
from pdf_extraction.bank.skills_from_pdf import (
    missing_sources,
    page_text,
    published_questions,
    slice_to_question,
)
from pdf_extraction.bank.tag import tag_and_rate

STORE = Path(__file__).resolve().parent.parent / "pdf_extraction" / "bank" / "extract.db"

#: Below this many characters the slice is a page number and a rubric line, not
#: a question. Tagging it would spend a call to be told nothing.
MIN_CHARS = 60

#: deepseek-chat list price per million tokens, cache-miss. Only used to print
#: an estimate before spending; the ledger records what was actually billed.
PRICE_IN, PRICE_OUT = 0.27, 1.10

#: Rough output size of one tagging reply, for the estimate only.
EST_OUTPUT_TOKENS = 60


def ensure_schema(connection: sqlite3.Connection) -> None:
    """Create the topic tables in a store written before they existed.

    Mirrors `backfill_skills_from_pdf.ensure_schema`. Idempotent.
    """
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS bank_topics (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_id INTEGER NOT NULL REFERENCES bank_subjects(id),
            code       TEXT,
            name       TEXT NOT NULL,
            UNIQUE (subject_id, name)
        );
        CREATE TABLE IF NOT EXISTS bank_question_topics (
            question_id INTEGER NOT NULL REFERENCES bank_questions(id) ON DELETE CASCADE,
            topic_id    INTEGER NOT NULL REFERENCES bank_topics(id),
            PRIMARY KEY (question_id, topic_id)
        );
        CREATE INDEX IF NOT EXISTS bank_question_topics_topic
            ON bank_question_topics(topic_id);
        """
    )


def already_tagged(connection: sqlite3.Connection) -> set[int]:
    """Question ids that already carry a topic, so a rerun resumes."""
    try:
        return {
            int(row[0])
            for row in connection.execute(
                "SELECT DISTINCT question_id FROM bank_question_topics"
            )
        }
    except sqlite3.OperationalError:
        return set()


def subject_id_for(connection: sqlite3.Connection, paper_source: str) -> int | None:
    row = connection.execute(
        "SELECT subject_id FROM bank_papers WHERE source_path = ? LIMIT 1",
        (paper_source,),
    ).fetchone()
    return None if row is None else int(row[0])


def write_topics(
    connection: sqlite3.Connection,
    subject_id: int,
    question_id: int,
    names: list[str],
) -> int:
    """Link a question to its topics, scoped to the subject. Returns rows written.

    Topics are per subject, not per paper: the same "Vectors" is one topic
    across every 9709 paper, which is what makes filtering by it useful. This
    mirrors `store._link_topics`, which cannot be reused directly because it
    takes a tagging object and re-derives the subject from a paper id.
    """
    connection.execute(
        "DELETE FROM bank_question_topics WHERE question_id = ?", (question_id,)
    )
    written = 0
    for name in names:
        name = str(name).strip()
        if not name:
            continue
        row = connection.execute(
            "SELECT id FROM bank_topics WHERE subject_id = ? AND name = ?",
            (subject_id, name),
        ).fetchone()
        if row is None:
            cursor = connection.execute(
                "INSERT INTO bank_topics (subject_id, code, name) VALUES (?, ?, ?)",
                (subject_id, None, name),
            )
            topic_id = int(cursor.lastrowid)
        else:
            topic_id = int(row[0])
        connection.execute(
            "INSERT OR IGNORE INTO bank_question_topics (question_id, topic_id) "
            "VALUES (?, ?)",
            (question_id, topic_id),
        )
        written += 1
    return written


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--subject", help="one syllabus code or IB slug")
    parser.add_argument("--limit", type=int, default=0, help="stop after N questions")
    parser.add_argument("--apply", action="store_true", help="call the model and write")
    parser.add_argument("--export", help="also write JSONL for the Neon carry")
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="re-tag questions that already have topics (default: skip them)",
    )
    parser.add_argument("--store", default=str(STORE))
    args = parser.parse_args()

    connection = sqlite3.connect(args.store)
    connection.row_factory = sqlite3.Row
    if args.apply:
        ensure_schema(connection)

    absent = missing_sources(connection)
    if absent:
        print(f"⚠ {len(absent)} source PDF(s) are not on this machine; those are skipped.")
        for path in absent[:3]:
            print(f"    {path}")

    done = set() if args.refresh else already_tagged(connection)
    if done:
        print(f"resuming: {len(done):,} question(s) already carry topics.")

    # Resolve every whitelist up front so an unconfigured subject is reported
    # before anything is spent, not discovered halfway through a paid run.
    whitelists: dict[str, tuple[list[str], str] | None] = {}
    unconfigured: Counter = Counter()

    per_subject: dict[str, Counter] = defaultdict(Counter)
    seen: Counter = Counter()
    thin: Counter = Counter()
    est_chars = 0
    considered = 0
    fallback = 0
    written = 0
    skipped_missing = 0
    in_tokens = out_tokens = 0
    failures = 0

    export = open(args.export, "w", encoding="utf-8") if args.export else None
    document: fitz.Document | None = None
    open_path: str | None = None
    subject_ids: dict[str, int | None] = {}

    try:
        for index, row in enumerate(published_questions(connection, args.subject)):
            if args.limit and considered >= args.limit:
                break

            subject = row["subject_code"]
            if subject not in whitelists:
                whitelists[subject] = topics_registry.topics_for(subject)
            listed = whitelists[subject]
            if listed is None:
                unconfigured[subject] += 1
                continue

            if not args.refresh and int(row["id"]) in done:
                continue

            path = row["source_path"]
            if not Path(path).exists():
                skipped_missing += 1
                continue

            # One open per paper, not per question: the rows are ordered by
            # source path so a 40-question paper is opened once.
            if path != open_path:
                if document is not None:
                    document.close()
                document = fitz.open(path)
                open_path = path

            text = page_text(document, row["page_start"], row["page_end"])
            sliced, ok = slice_to_question(text, row["root_number"])
            if not ok:
                fallback += 1
            sliced = sliced.strip()

            seen[subject] += 1
            if len(sliced) < MIN_CHARS:
                thin[subject] += 1
                continue

            considered += 1
            est_chars += len(sliced)

            if not args.apply:
                continue

            allowed, context = listed
            try:
                tagging, call = tag_and_rate(sliced, allowed, context)
            except Exception as error:  # noqa: BLE001 - one question must not end the run
                failures += 1
                if failures <= 5:
                    print(f"  ! {path} q{row['root_number']}: {error}")
                continue

            in_tokens += call.input_tokens
            out_tokens += call.output_tokens

            chosen = [str(t) for t in (tagging.topics or [])]
            for name in chosen:
                per_subject[subject][name] += 1

            if subject not in subject_ids:
                subject_ids[subject] = subject_id_for(connection, path)
            subject_id = subject_ids[subject]
            if subject_id is not None and chosen:
                written += write_topics(connection, subject_id, int(row["id"]), chosen)

            if export is not None:
                export.write(
                    json.dumps(
                        {
                            "source_path": path,
                            "root_number": row["root_number"],
                            "subject": subject,
                            "topics": chosen,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )

            if considered % 200 == 0:
                connection.commit()
                print(f"  … {considered:,} tagged, {written:,} links, "
                      f"${in_tokens/1e6*PRICE_IN + out_tokens/1e6*PRICE_OUT:,.2f} so far",
                      flush=True)
    finally:
        if document is not None:
            document.close()
        if export is not None:
            export.close()
        if args.apply:
            connection.commit()

    # ---- report ----
    print()
    if unconfigured:
        total = sum(unconfigured.values())
        print(f"⚠ {total:,} question(s) skipped: no syllabus list for "
              f"{len(unconfigured)} subject(s)")
        for code, count in unconfigured.most_common():
            print(f"    {code:<45} {count:,}")
        print("  Add them to pdf_extraction/bank/syllabus_topics.json, or run "
              "--subject to stay off them.")
        print()

    if args.apply:
        for subject in sorted(per_subject):
            chosen = per_subject[subject]
            total = seen[subject] - thin[subject]
            covered = sum(chosen.values())
            print(f"{subject}  ({total:,} tagged, {covered:,} links)")
            for name, count in chosen.most_common(6):
                print(f"    {name:<50} {count:,}")
            unused = [t for t in (whitelists[subject] or ([], ""))[0] if t not in chosen]
            if unused:
                print(f"    ⚠ {len(unused)} syllabus topic(s) never chosen: "
                      f"{', '.join(unused[:4])}"
                      f"{' …' if len(unused) > 4 else ''}")
            print()

        cost = in_tokens / 1e6 * PRICE_IN + out_tokens / 1e6 * PRICE_OUT
        print(f"{considered:,} question(s) tagged, {written:,} topic link(s) written.")
        print(f"{fallback:,} fell back to the whole page span.")
        if failures:
            print(f"⚠ {failures:,} question(s) failed and were left untagged.")
        print(f"tokens: {in_tokens:,} in, {out_tokens:,} out  ≈ ${cost:,.2f}")
    else:
        thin_total = sum(thin.values())
        est_in = est_chars / 3.5 + considered * 220
        est_cost = est_in / 1e6 * PRICE_IN + considered * EST_OUTPUT_TOKENS / 1e6 * PRICE_OUT
        print(f"{sum(seen.values()):,} question(s) have a syllabus list and a PDF.")
        print(f"{thin_total:,} carry too little text to tag (under {MIN_CHARS} chars).")
        print(f"{fallback:,} fell back to the whole page span.")
        if skipped_missing:
            print(f"{skipped_missing:,} skipped for a missing PDF.")
        print(f"\n{considered:,} question(s) would be tagged.")
        print(f"estimate: ~{est_in/1e6:,.1f}M input tokens, "
              f"~{considered*EST_OUTPUT_TOKENS/1e6:,.1f}M output "
              f"≈ ${est_cost:,.2f} at deepseek-chat list price.")
        print("\ndry run -- nothing called, nothing written. Rerun with --apply.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
