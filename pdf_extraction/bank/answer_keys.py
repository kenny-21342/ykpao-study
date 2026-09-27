"""Backfill multiple-choice answer keys already printed in the mark schemes.

    python3 -m pdf_extraction.bank.answer_keys              # report only (default)
    python3 -m pdf_extraction.bank.answer_keys --apply      # write answer_letter
    python3 -m pdf_extraction.bank.answer_keys --board IB

Like ``marks``, nothing here calls a model or a network. The key is a letter
printed in a table; paying a provider to read it back would be spending money
on a lookup.

**Why this exists.** ``spans._detect_answer_key`` required the question number
to be a bare integer, and the IB writes it with a trailing period -- ``1.``
then ``B``. So the detector recognised no IB answer key at all. Production held
**zero** keys for 9,408 published IB Paper 1 questions, every one of which is a
multiple-choice question whose answer was sitting in a mark scheme we already
had on disk.

What that cost is not subtle. ``lib/paper-format-overlay.ts`` decides a paper
is multiple choice from the share of its questions carrying a key, so an IB
Paper 1 measured as ``structured``; and ``decideGradingMode`` sends an unkeyed
question to a model. A generated IB Physics Paper 1 was therefore forty
multiple-choice questions sent one at a time to a vision model to be marked
against no mark scheme -- slow, paid for, and wrong.

The detector is fixed, but fixing it only helps papers processed from now on.
This pass re-reads the mark schemes already in the store and fills what the old
detector missed: 221 papers and about 7,677 keys.

**Strictly additive, unlike ``store.record_answer_key``.** That writer is an
INSERT OR REPLACE and sets ``answer_md`` to the letter, which is right during a
first extraction and wrong here -- a row that already carries a real mark
scheme would lose it. This only inserts rows that do not exist and only sets
``answer_letter`` where it is NULL. It never writes ``answer_md`` on an
existing row, so a re-run is a no-op and a mistake cannot destroy anything.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

from . import store
from .spans import _detect_answer_key

DB = Path(__file__).resolve().parent / "extract.db"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write; otherwise report only")
    parser.add_argument("--board", help="limit to one board, e.g. IB")
    parser.add_argument("--run-id", default="answer-key-backfill")
    args = parser.parse_args(argv)

    connection = sqlite3.connect(str(DB))
    connection.row_factory = sqlite3.Row

    where = "WHERE p.doc_type = 'ms'" + (" AND p.board = :board" if args.board else "")
    papers = connection.execute(
        f"""SELECT p.id, p.source_path, p.board, p.paper_number,
                   s.code, s.level
            FROM bank_papers p JOIN bank_subjects s ON s.id = p.subject_id
            {where}
            ORDER BY s.code, p.paper_number""",
        {"board": args.board} if args.board else {},
    ).fetchall()

    detected = inserted = updated = skipped_missing = 0
    papers_detected = 0
    for paper in papers:
        path = Path(paper["source_path"])
        if not path.exists():
            skipped_missing += 1
            continue
        spans = _detect_answer_key(path)
        if spans is None or not spans.answer_key:
            continue
        papers_detected += 1

        existing = {
            row["root_number"]: row
            for row in connection.execute(
                "SELECT root_number, answer_letter FROM bank_mark_schemes WHERE paper_id = ?",
                (paper["id"],),
            )
        }
        for root_number, letter in spans.answer_key:
            detected += 1
            row = existing.get(root_number)
            if row is None:
                inserted += 1
                if args.apply:
                    connection.execute(
                        """INSERT INTO bank_mark_schemes
                               (paper_id, root_number, answer_md, marking_points,
                                total_marks, answer_letter, confidence, status,
                                run_id, model, prompt_version)
                           VALUES (?, ?, ?, '[]', 1, ?, 1.0, 'published', ?,
                                   'deterministic', 'answer-key-v2')""",
                        (paper["id"], root_number, letter, letter, args.run_id),
                    )
            elif row["answer_letter"] is None:
                updated += 1
                if args.apply:
                    # answer_md is deliberately left alone: if this row holds a
                    # real mark scheme, the letter is an addition to it, not a
                    # replacement for it.
                    connection.execute(
                        "UPDATE bank_mark_schemes SET answer_letter = ? WHERE paper_id = ? AND root_number = ?",
                        (letter, paper["id"], root_number),
                    )

    linked = 0
    if args.apply:
        # A mark scheme and its question are separate documents, so the pairing
        # can only be made once both are in the store. The pusher finds its
        # target through question_id, so an unlinked row cannot reach production.
        linked = store.link_mark_schemes_to_questions(connection)
        connection.commit()

    print(f"mark schemes scanned:        {len(papers):,}")
    print(f"  detected as an answer key: {papers_detected:,}")
    print(f"  keys read:                 {detected:,}")
    print(f"  rows to insert:            {inserted:,}")
    print(f"  keys to add to a row:      {updated:,}")
    if skipped_missing:
        print(f"  source PDF missing:        {skipped_missing:,}")
    if args.apply:
        print(f"  newly linked to questions: {linked:,}")
    else:
        print("\nnothing written. Re-run with --apply.")
    connection.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
