#!/usr/bin/env python3
"""
Give HL and SL questions the mark scheme IB published for both levels.

    python3 -m pdf_extraction.bank.link_combined_mark_schemes --dry-run
    python3 -m pdf_extraction.bank.link_combined_mark_schemes

For some IB papers one mark scheme covers HL and SL together. The pipeline
files it under a combined subject row (level ``HLSL``) while the question
papers sit under the separate HL and SL rows, and ``relink_mark_schemes``
joins on the subject row, so those mark schemes never meet their questions:
968 published IB questions on 15 Oct 2026 (measured against ``extract.db``).

The pairing is deterministic -- same syllabus code, year, session, paper,
variant, time zone and question number -- and needs no model. It is applied
only where exactly one combined mark scheme matches, and never to a question
that already has one.

A mark scheme row has ``UNIQUE (paper_id, root_number)`` and ``UNIQUE
(question_id)``, so one combined row cannot serve two questions. Each HL or
SL question therefore gets its own COPY (text, marking points, strips and
asset links), filed under the question's own paper id. Production's pusher
(``apply-mark-scheme-links.mjs``) keys on the question, not on the mark
scheme's paper, so the copies travel through the existing, tested path:

    link_combined_mark_schemes -> apply-mark-scheme-links.mjs
        -> upload-bank-assets.ts --shas -> apply-mark-scheme-strips.mts
"""

from __future__ import annotations

import argparse
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

from . import store

DB = Path(__file__).resolve().parent / "extract.db"

UNLINKED_QUESTIONS = """
    SELECT q.id AS question_id, q.root_number, p.id AS paper_id, p.year, p.session,
           p.paper_number, p.variant, IFNULL(p.timezone, '') AS tz, s.code, s.level
    FROM bank_questions q
    JOIN bank_papers p ON p.id = q.paper_id AND p.doc_type = 'qp' AND p.board = 'IB'
    JOIN bank_subjects s ON s.id = p.subject_id AND s.level IN ('HL', 'SL')
    LEFT JOIN bank_mark_schemes ms ON ms.question_id = q.id
    WHERE q.status = 'published' AND ms.id IS NULL
"""

COMBINED_SCHEMES = """
    SELECT ms.id, ms.root_number, ms.answer_md, ms.marking_points, ms.total_marks,
           ms.answer_letter, ms.confidence, ms.status, ms.run_id, ms.model, ms.prompt_version,
           mp.year, mp.session, mp.paper_number, mp.variant, IFNULL(mp.timezone, '') AS tz, s.code
    FROM bank_mark_schemes ms
    JOIN bank_papers mp ON mp.id = ms.paper_id AND mp.doc_type = 'ms' AND mp.board = 'IB'
    JOIN bank_subjects s ON s.id = mp.subject_id AND s.level = 'HLSL'
"""


def plan(connection: sqlite3.Connection):
    """(question row, combined scheme row) pairs, and what was left unpaired."""
    schemes: dict[tuple, list[sqlite3.Row]] = defaultdict(list)
    for row in connection.execute(COMBINED_SCHEMES):
        key = (row["code"], row["year"], row["session"], row["paper_number"],
               row["variant"], row["tz"], row["root_number"])
        schemes[key].append(row)

    pairs, skipped = [], Counter()
    for question in connection.execute(UNLINKED_QUESTIONS):
        key = (question["code"], question["year"], question["session"], question["paper_number"],
               question["variant"], question["tz"], question["root_number"])
        found = schemes.get(key, [])
        if not found:
            skipped["no combined mark scheme"] += 1
        elif len(found) > 1:
            skipped["several combined mark schemes match (ambiguous)"] += 1
        else:
            pairs.append((question, found[0]))
    return pairs, skipped


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, default=DB)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.dry_run:
        connection = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
    else:
        connection = store.connect(args.db)

    pairs, skipped = plan(connection)
    levels = Counter(question["level"] for question, _ in pairs)
    statuses = Counter(scheme["status"] for _, scheme in pairs)
    print(f"{len(pairs):,} questions can take a combined mark scheme "
          f"({dict(levels)}); source statuses {dict(statuses)}")
    for reason, count in skipped.items():
        print(f"  {count:>6,} unpaired: {reason}")
    if args.dry_run or not pairs:
        if args.dry_run:
            print("Dry run: nothing written.")
        connection.close()
        return 0

    created = copies = 0
    for question, scheme in pairs:
        # The copy is filed under the QUESTION's paper: (paper_id, root_number)
        # is unique, and the combined row already occupies its own paper's slot.
        cursor = connection.execute(
            """INSERT OR IGNORE INTO bank_mark_schemes
               (question_id, paper_id, root_number, answer_md, marking_points, total_marks,
                answer_letter, confidence, status, run_id, model, prompt_version)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (question["question_id"], question["paper_id"], question["root_number"],
             scheme["answer_md"], scheme["marking_points"], scheme["total_marks"],
             scheme["answer_letter"], scheme["confidence"], scheme["status"],
             scheme["run_id"], scheme["model"], scheme["prompt_version"]),
        )
        if not cursor.rowcount:
            continue
        new_id = cursor.lastrowid
        created += 1
        copies += connection.execute(
            """INSERT INTO bank_mark_scheme_strips (mark_scheme_id, asset_id, ordering, page)
               SELECT ?, asset_id, ordering, page FROM bank_mark_scheme_strips WHERE mark_scheme_id = ?""",
            (new_id, scheme["id"]),
        ).rowcount
        connection.execute(
            """INSERT INTO bank_mark_scheme_assets (mark_scheme_id, asset_id, placeholder, ordering)
               SELECT ?, asset_id, placeholder, ordering FROM bank_mark_scheme_assets WHERE mark_scheme_id = ?""",
            (new_id, scheme["id"]),
        )
    connection.commit()
    print(f"created {created:,} mark scheme rows and {copies:,} strip links")
    connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
