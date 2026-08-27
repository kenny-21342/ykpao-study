#!/usr/bin/env python3
"""
Attach mark schemes to their questions, one row at a time.

    python3 -m pdf_extraction.bank.relink_mark_schemes --dry-run   # report only
    python3 -m pdf_extraction.bank.relink_mark_schemes             # write

A mark scheme is a separate document from its question paper, so it is stored
before the questions it belongs to necessarily exist and `question_id` is
filled in afterwards. `store.link_mark_schemes_to_questions` does that in a
single correlated UPDATE.

That statement has been failing silently for the whole corpus. `question_id`
carries a UNIQUE constraint, and IB option papers collapse to one identity --
`parse_ib_path` reads nothing after `_paper_N`, so four History route-2 paper-1
mark schemes (different options, one a Spanish translation) look identical. The
UPDATE assigns one question to several of them, hits the constraint, and
SQLite's default ON CONFLICT ABORT rolls back the ENTIRE statement. Not one row
is linked. The exception is then swallowed by a broad `except` in run_corpus,
which logs a line nobody reads.

The evidence is that linked ids form a contiguous prefix: everything up to
45,865 was linked before the IB corpus arrived, and nothing since. 21,667
published mark schemes -- every one in IB, and all of Physics 0625 -- never
reached production, because merge_to_neon skips rows with no question.

So this links row by row, and a collision costs one row instead of all of them.
It links only where the pairing is unambiguous in both directions; the rest are
reported rather than guessed at, because the old correlated subquery silently
picked whichever row SQLite happened to yield first.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import time
from collections import Counter, defaultdict
from pathlib import Path

from . import store

DB = Path(__file__).resolve().parent / "extract.db"

# Every mark scheme with no question, beside the questions it could belong to.
# A question paper and its mark scheme share everything the filename says
# except doc_type, so that is the join.
CANDIDATES = """
    SELECT ms.id AS ms_id, ms.status AS ms_status, q.id AS q_id,
           mp.source_path AS ms_path, qp.source_path AS qp_path
    FROM bank_mark_schemes ms
    JOIN bank_papers mp ON mp.id = ms.paper_id
    JOIN bank_papers qp ON qp.subject_id = mp.subject_id
        AND qp.year = mp.year
        AND qp.session = mp.session
        AND qp.paper_number = mp.paper_number
        AND qp.variant = mp.variant
        AND IFNULL(qp.timezone, '') = IFNULL(mp.timezone, '')
        AND qp.doc_type = 'qp'
    JOIN bank_questions q ON q.paper_id = qp.id AND q.root_number = ms.root_number
    WHERE ms.question_id IS NULL
"""

# Questions that already have a mark scheme cannot take another: the column is
# UNIQUE, so offering them again is what produced the collisions.
CLAIMED = "SELECT question_id FROM bank_mark_schemes WHERE question_id IS NOT NULL"


# Everything after "_paper_<N>" in an IB filename is the option: the route,
# topic or language that distinguishes papers sharing one identity.
_OPTION = re.compile(r"_paper_\d+_(.*)$", re.IGNORECASE)

# Suffixes that describe the document rather than the option.
_NOT_OPTION = re.compile(
    r"(markscheme|marking_?scheme|_ms|TZ\d|HLSL|HL|SL|Spa|Fre|Ger|paper\d*)",
    re.IGNORECASE,
)

# How far ahead the best candidate must be before it is trusted. The option
# token is not written identically on both sides -- one paper says
# "the_Middle_East" where its mark scheme says "the_ME" -- so an exact match
# would refuse pairs a human would make instantly. A margin means a clear
# winner is taken and a close call is still left alone.
_TIEBREAK_MARGIN = 0.25


def option_tokens(source_path: str) -> frozenset[str]:
    """The words identifying which option a paper is, as a set."""
    stem = Path(source_path).stem
    match = _OPTION.search(stem)
    if not match:
        return frozenset()
    words = _NOT_OPTION.sub(" ", match.group(1)).replace("_", " ")
    return frozenset(
        word.lower() for word in re.split(r"[^\w-]+", words)
        if len(word) > 2
    )


def _similarity(first: frozenset[str], second: frozenset[str]) -> float:
    """Jaccard overlap; 0 when either side names no option."""
    if not first or not second:
        return 0.0
    return len(first & second) / len(first | second)


def resolve_by_option(rows) -> int | None:
    """The question whose paper names the same option, when one clearly does.

    Returns None if nothing stands out, which leaves the group for a human.
    """
    scores: dict[int, float] = {}
    for row in rows:
        score = _similarity(option_tokens(row["ms_path"]), option_tokens(row["qp_path"]))
        scores[row["q_id"]] = max(scores.get(row["q_id"], 0.0), score)
    if not scores:
        return None
    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)
    best_id, best = ranked[0]
    runner_up = ranked[1][1] if len(ranked) > 1 else 0.0
    if best > 0 and best - runner_up >= _TIEBREAK_MARGIN:
        return best_id
    return None

def plan_links(connection: sqlite3.Connection):
    """Decide which mark schemes can be linked without guessing.

    Returns the unambiguous pairs and the groups that need a human, keeping
    them apart rather than resolving ties arbitrarily.
    """
    claimed = {row[0] for row in connection.execute(CLAIMED)}

    by_ms: dict[int, list[sqlite3.Row]] = defaultdict(list)
    by_question: dict[int, list[sqlite3.Row]] = defaultdict(list)
    for row in connection.execute(CANDIDATES):
        if row["q_id"] in claimed:
            continue
        by_ms[row["ms_id"]].append(row)
        by_question[row["q_id"]].append(row)

    links: list[tuple[int, int]] = []
    ambiguous: list[dict] = []
    for ms_id, rows in by_ms.items():
        questions = {row["q_id"] for row in rows}
        if len(questions) != 1:
            # Several question papers share this identity -- the IB option
            # case. If one of them names the same option as the mark scheme,
            # and clearly more so than the rest, take it.
            chosen = resolve_by_option(rows)
            if chosen is not None and chosen not in claimed:
                links.append((chosen, ms_id))
                claimed.add(chosen)
                continue
            ambiguous.append({
                "reason": "one mark scheme, several questions",
                "ms_id": ms_id,
                "ms_path": rows[0]["ms_path"],
                "question_ids": sorted(questions),
            })
            continue

        question_id = next(iter(questions))
        # The other direction matters just as much: several mark schemes
        # competing for one question is the IB option-paper case, and linking
        # whichever comes first would be a coin toss recorded as fact.
        rivals = {row["ms_id"] for row in by_question[question_id]}
        if len(rivals) != 1:
            ambiguous.append({
                "reason": "several mark schemes, one question",
                "question_id": question_id,
                "ms_ids": sorted(rivals),
                "ms_paths": sorted({row["ms_path"] for row in by_question[question_id]}),
            })
            continue

        links.append((question_id, ms_id))

    return links, ambiguous


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=DB)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="write the ambiguous groups here as JSON",
    )
    args = parser.parse_args()

    if args.dry_run:
        connection = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 30000")
    else:
        connection = store.connect(args.db)

    started = time.time()
    links, ambiguous = plan_links(connection)
    if args.limit:
        links = links[: args.limit]

    print(
        f"{len(links):,} unambiguous links, {len(ambiguous):,} groups need a human"
        + (" (dry run)" if args.dry_run else ""),
        flush=True,
    )

    tally: Counter = Counter()
    if not args.dry_run:
        for index, (question_id, ms_id) in enumerate(links, 1):
            try:
                connection.execute(
                    "UPDATE bank_mark_schemes SET question_id = ? WHERE id = ?",
                    (question_id, ms_id),
                )
                tally["linked"] += 1
            except sqlite3.IntegrityError as error:
                # One row's problem, not the batch's. This is the whole point.
                tally[f"conflict:{type(error).__name__}"] += 1
            if index % 200 == 0:
                connection.commit()
                print(f"  ...{index:,}/{len(links):,} linked", flush=True)
        connection.commit()

    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(ambiguous, indent=1), encoding="utf-8")
        print(f"  ambiguous groups written to {args.report}")

    reasons = Counter(entry["reason"] for entry in ambiguous)
    for reason, count in reasons.most_common():
        print(f"  {count:>6,}  {reason}")
    for key, count in sorted(tally.items()):
        print(f"  {count:>6,}  {key}")

    remaining = connection.execute(
        "SELECT count(*) FROM bank_mark_schemes WHERE question_id IS NULL"
    ).fetchone()[0]
    print(f"\n{remaining:,} mark schemes still unlinked "
          f"in {time.time() - started:.0f}s")
    connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
