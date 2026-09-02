"""Backfill command terms for the whole bank, from the source PDFs.

Usage:
    python3 scripts/backfill_skills_from_pdf.py                    # dry run
    python3 scripts/backfill_skills_from_pdf.py --subject 9618
    python3 scripts/backfill_skills_from_pdf.py --apply            # write SQLite
    python3 scripts/backfill_skills_from_pdf.py --apply --export skills.jsonl

Reads no model. The question papers are on disk with a real text layer, so this
is arithmetic over files you already have; see `pdf_extraction/bank/skills_from_pdf`
for the accuracy it was measured at.

`--apply` writes `bank_skills` / `bank_question_skills` in the local store, which
is the pipeline's source of truth. `--export` additionally writes a JSONL of
`{source_path, root_number, terms}` for `scripts/backfill-command-terms.ts
--from`, which is what carries the result to Neon: the two databases number
their questions independently, so the paper's source path and the printed root
number are the only join key that means the same thing on both sides.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import fitz

from pdf_extraction.bank.skills_from_pdf import (
    missing_sources,
    published_questions,
    skills_for_question,
)

STORE = Path(__file__).resolve().parent.parent / "pdf_extraction" / "bank" / "extract.db"


def ensure_schema(connection: sqlite3.Connection) -> None:
    """Create the skills tables in a store written before they existed.

    `extract.db` predates them, and nothing else creates tables in an existing
    store -- the schema is applied when a store is first made. Idempotent, so a
    store that already has them is untouched.
    """
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS bank_skills (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            slug  TEXT NOT NULL UNIQUE,
            label TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bank_question_skills (
            question_id INTEGER NOT NULL REFERENCES bank_questions(id) ON DELETE CASCADE,
            skill_id    INTEGER NOT NULL REFERENCES bank_skills(id),
            confidence  REAL    NOT NULL DEFAULT 0,
            PRIMARY KEY (question_id, skill_id)
        );
        CREATE INDEX IF NOT EXISTS idx_bank_question_skills_skill
            ON bank_question_skills(skill_id);
        """
    )


def ensure_skill(connection: sqlite3.Connection, cache: dict[str, int], slug: str) -> int:
    if slug in cache:
        return cache[slug]
    row = connection.execute("SELECT id FROM bank_skills WHERE slug = ?", (slug,)).fetchone()
    if row:
        cache[slug] = int(row[0])
    else:
        cursor = connection.execute(
            "INSERT INTO bank_skills (slug, label) VALUES (?, ?)",
            (slug, slug.replace("-", " ")),
        )
        cache[slug] = int(cursor.lastrowid)
    return cache[slug]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--subject", help="one subject code, e.g. 9618")
    parser.add_argument("--apply", action="store_true", help="write to the local store")
    parser.add_argument("--export", help="also write a JSONL for the Neon step")
    parser.add_argument("--limit", type=int, help="stop after N questions")
    parser.add_argument("--db", default=str(STORE))
    args = parser.parse_args()

    connection = sqlite3.connect(args.db)
    connection.row_factory = sqlite3.Row

    if args.apply:
        ensure_schema(connection)

    absent = missing_sources(connection)
    if absent:
        print(f"⚠ {len(absent)} source PDF(s) are not on this machine; those questions are skipped.")
        for path in absent[:3]:
            print(f"    {path}")

    per_subject: dict[str, Counter] = defaultdict(Counter)
    seen: Counter = Counter()
    blank: Counter = Counter()
    fallback = 0
    written = 0
    skipped = 0

    export = open(args.export, "w", encoding="utf-8") if args.export else None
    skill_cache: dict[str, int] = {}

    document: fitz.Document | None = None
    open_path: str | None = None

    try:
        for index, row in enumerate(published_questions(connection, args.subject)):
            if args.limit and index >= args.limit:
                break

            path = row["source_path"]
            if not Path(path).exists():
                skipped += 1
                continue

            # One open per paper, not per question: the rows are ordered by
            # source path so a 40-question paper is opened once.
            if path != open_path:
                if document is not None:
                    document.close()
                document = fitz.open(path)
                open_path = path

            extracted = skills_for_question(
                document, row["root_number"], row["page_start"], row["page_end"]
            )
            if extracted.strategy == "page":
                fallback += 1

            # Confidence records how the text was found, not how sure the words
            # are: 1.0 when the question's own number was located and the slice
            # is certainly its text, 0.5 when the whole page span was used and a
            # neighbouring question's verbs may have bled in.
            confidence = 1.0 if extracted.strategy == "sliced" else 0.5

            code = row["subject_code"]
            seen[code] += 1
            if not extracted.terms:
                blank[code] += 1
            per_subject[code].update(extracted.terms)

            if export:
                export.write(
                    json.dumps(
                        {
                            "source_path": path,
                            "root_number": row["root_number"],
                            "terms": extracted.terms,
                            "confidence": confidence,
                        }
                    )
                    + "\n"
                )

            if args.apply and extracted.terms:
                connection.execute(
                    "DELETE FROM bank_question_skills WHERE question_id = ?", (row["id"],)
                )
                for slug in extracted.terms:
                    connection.execute(
                        "INSERT OR REPLACE INTO bank_question_skills "
                        "(question_id, skill_id, confidence) VALUES (?, ?, ?)",
                        (row["id"], ensure_skill(connection, skill_cache, slug), confidence),
                    )
                written += len(extracted.terms)

            if index % 2000 == 0:
                print(f"\r  {index} questions", end="", flush=True)

        if args.apply:
            connection.commit()
    finally:
        if document is not None:
            document.close()
        if export:
            export.close()
        connection.close()

    print("\r" + " " * 30 + "\r", end="")

    for code in sorted(seen):
        counted = seen[code]
        empty = blank[code]
        top = per_subject[code].most_common(6)
        print(f"{code}  ({counted} questions, {empty} with no command term -- {empty * 100 // counted}%)")
        for slug, count in top:
            print(f"    {slug:<12} {count:>6}  {count * 100 // counted}%")
        if counted >= 50 and empty / counted > 0.5:
            print("    ⚠ over half carry no term -- check this subject by hand before trusting it")
        if top and top[0][1] / counted > 0.9 and counted >= 50:
            print(f'    ⚠ "{top[0][0]}" on over 90% -- check the extraction, not the students')
        print()

    total = sum(seen.values())
    print(f"{total} question(s) read, {skipped} skipped for a missing PDF.")
    print(f"{fallback} fell back to the whole page span ({fallback * 100 // max(total, 1)}%).")
    if args.apply:
        print(f"✓ wrote {written} question-skill link(s) to {args.db}")
    else:
        print("dry run -- nothing written. Rerun with --apply.")
    if args.export:
        print(f"✓ exported {args.export}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
