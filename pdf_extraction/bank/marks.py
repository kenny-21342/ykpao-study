"""Stage 1 — deterministic mark totals, read off the question paper.

    python3 -m pdf_extraction.bank.marks --dry-run    # report only (default)
    python3 -m pdf_extraction.bank.marks --apply      # write total_marks

Nothing here calls a model or a network, in the same spirit as the
multiple-choice answer-key pass: the marks are printed on the page, so paying
a provider to read them back would be spending money on arithmetic.

**Why this exists.** `bank_mark_schemes.total_marks` is set by exactly one
writer -- `store.record_answer_key`, which stamps `1` on every multiple-choice
question it recovers. Every other mark scheme in the corpus is a crop-only row
with `total_marks` NULL. Mock-exam selection requires a mark total to weight a
paper, so it drew *only* multiple-choice questions: a 50-mark Biology paper
came back as fifty one-mark questions, and Additional Mathematics, Computer
Science, English and Literature could not be served at all despite having
thousands of published questions between them.

**Where the number comes from.** CAIE prints the mark allocation in square
brackets at the end of every part -- `[3]` -- which is what a candidate reads
to budget their time. `qa._CROP_MARKS` already looks for exactly this pattern
to decide whether a crop kept its marks column, so the corpus is known to carry
it; this sums the values instead of merely noticing them.

The mark scheme's own Marks column is deliberately *not* used. Pre-2018 layouts
put mark codes there (`M1`, `A1`, `B3`) rather than totals, and a question with
an alternative scheme lists every route, so summing them double-counts a
question that offers two ways to earn the same three marks.

**What is deliberately skipped.** A paper is written only when every one of its
questions yields a total, which excludes two cases that would otherwise write
nonsense:

*   Multiple-choice papers print no allocation at all, so every question reads
    zero. Those already carry `total_marks = 1` from the answer-key pass.
*   Papers offering a choice of question ("answer one of...") print brackets
    for more questions than a candidate answers, so the sums exceed the paper
    total. `MAX_QUESTION_MARKS` catches the worst of these; the rest are
    reported by `--dry-run` for a human to look at before `--apply`.
"""

from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

import fitz

from .spans import detect_root_spans

DB = Path(__file__).resolve().parent / "extract.db"

MARKS_VERSION = "marks-v1"

# The allocation CAIE prints at the end of a part: "[3]", "[ 12 ]".
_BRACKET = re.compile(r"\[\s*(\d{1,2})\s*\]")

# No single IGCSE root question is worth more than this. A larger total means
# the brackets were not all for one question -- a choice paper counted twice
# over, or a span that swallowed its neighbour.
MAX_QUESTION_MARKS = 40

# What share of a subject-and-paper cohort must agree on the same total before
# any of that cohort is trusted.
#
# A paper's own numbers cannot tell you whether they are right; the cohort can.
# Additional Mathematics paper 1 reads exactly 80 on all 140 papers, and the
# science papers read 80 or 40 on 91-100% of theirs -- those are the published
# totals, arrived at independently 140 times. Papers offering a choice of
# question never converge, because the brackets counted include questions no
# candidate answers: Economics paper 2 spreads across 110, 130, 188 and 190
# against a real 90, and History reads as high as 620.
COHORT_AGREEMENT = 0.90


def marks_for_paper(path: Path) -> dict[int, int] | None:
    """Marks per root question, or None if this paper does not print them.

    Returns None rather than a dict of zeroes so a caller cannot mistake "this
    is a multiple-choice paper" for "every question here is worth nothing".
    """
    spans = detect_root_spans(path, doc_type="qp")
    if not spans.spans:
        return None

    totals: dict[int, int] = {}
    with fitz.open(path) as document:
        for span in spans.spans:
            marks = 0
            for region in span.regions:
                clip = fitz.Rect(*region.bbox)
                text = document[region.page - 1].get_text(clip=clip)
                marks += sum(int(value) for value in _BRACKET.findall(text))
            totals[span.root_number] = marks

    return totals if is_plausible(totals) else None


def is_plausible(totals: dict[int, int]) -> bool:
    """Whether a paper's extracted marks are safe to store.

    All-or-nothing per paper, for two reasons that pull the same way. A paper
    where only some questions found their marks has a span problem, and half a
    paper of totals is worse than none -- selection would quietly prefer the
    questions that happened to parse, biasing every generated exam towards them.
    And a multiple-choice paper reads as every question worth zero, which must
    not be mistaken for a structured paper that failed.

    The upper bound catches a span that swallowed its neighbour, and choice
    papers ("answer one of...") where the printed brackets outnumber the
    questions a candidate actually answers.
    """
    if not totals:
        return False
    if any(marks <= 0 for marks in totals.values()):
        return False
    if any(marks > MAX_QUESTION_MARKS for marks in totals.values()):
        return False
    return True


def trusted_totals(
    cohort: dict[tuple[str, int], list[tuple[int, int]]],
) -> set[int]:
    """The paper ids whose totals agree with their cohort's consensus.

    `cohort` maps (subject, paper number) to (paper id, paper total) pairs. A
    paper is trusted when its cohort reaches `COHORT_AGREEMENT` on one total and
    this paper reports that total. Everything else is left unwritten -- a
    NULL mark total costs one question its place in a generated exam, while a
    wrong one silently mis-weights it.
    """
    trusted: set[int] = set()
    for entries in cohort.values():
        if not entries:
            continue
        counts = Counter(total for _, total in entries)
        mode, hits = counts.most_common(1)[0]
        if hits / len(entries) < COHORT_AGREEMENT:
            continue
        trusted.update(paper_id for paper_id, total in entries if total == mode)
    return trusted


def _papers(connection: sqlite3.Connection, subject: str | None) -> list[sqlite3.Row]:
    """Question papers holding at least one question with no mark total."""
    sql = """
        SELECT p.id, p.source_path, s.code AS subject, p.year, p.paper_number
        FROM bank_papers p
        JOIN bank_subjects s ON s.id = p.subject_id
        WHERE p.doc_type = 'qp'
          AND EXISTS (
            SELECT 1 FROM bank_questions q
            WHERE q.paper_id = p.id AND q.total_marks IS NULL
          )
    """
    params: tuple = ()
    if subject:
        sql += " AND s.code = ?"
        params = (subject,)
    sql += " ORDER BY s.code, p.year, p.paper_number"
    return connection.execute(sql, params).fetchall()


def run(*, apply: bool, subject: str | None, limit: int | None) -> int:
    """Scan every candidate paper, then write only the cohorts that agree.

    Two passes, deliberately. Nothing can be written during the scan because a
    paper's totals are only trustworthy relative to the other papers sitting the
    same syllabus and paper number, and that cohort is not complete until the
    scan is.
    """
    connection = sqlite3.connect(str(DB))
    connection.row_factory = sqlite3.Row

    papers = _papers(connection, subject)
    if limit:
        papers = papers[:limit]

    print(f"scanning {len(papers)} question papers with unmarked questions\n")

    scanned: dict[int, dict[int, int]] = {}
    cohort: dict[tuple[str, int], list[tuple[int, int]]] = defaultdict(list)
    label_of: dict[int, str] = {}
    skipped = 0

    for paper in papers:
        path = Path(paper["source_path"])
        label = f"{paper['subject']:10} {paper['year']:4} p{paper['paper_number']}"
        label_of[paper["id"]] = label
        if not path.exists():
            print(f"{label}  source file missing")
            continue
        try:
            totals = marks_for_paper(path)
        except Exception as error:  # a damaged PDF must not stop the run
            print(f"{label}  ERROR {type(error).__name__}: {error}")
            continue
        if totals is None:
            skipped += 1
            continue
        scanned[paper["id"]] = totals
        cohort[(paper["subject"], paper["paper_number"])].append(
            (paper["id"], sum(totals.values()))
        )

    trusted = trusted_totals(cohort)

    written = 0
    for paper_id, totals in scanned.items():
        if paper_id not in trusted:
            continue
        for root_number, marks in totals.items():
            cursor = connection.execute(
                """
                UPDATE bank_questions SET total_marks = ?
                WHERE paper_id = ? AND root_number = ? AND total_marks IS NULL
                """,
                (marks, paper_id, root_number),
            )
            written += cursor.rowcount

    if apply:
        connection.commit()
    else:
        connection.rollback()
    connection.close()

    print(f"\n{'=' * 62}")
    print(f"{len(scanned):>6} papers read their marks")
    print(f"{len(trusted):>6} in a cohort agreeing at "
          f"{int(COHORT_AGREEMENT * 100)}% or better -- these are written")
    print(f"{len(scanned) - len(trusted):>6} held back: their cohort never agreed on a total")
    print(f"{skipped:>6} skipped: no printed allocation (multiple choice, or an "
          f"unreadable layout)")
    print(f"{written:>6} questions {'written' if apply else 'would be written'}")

    print("\nBy subject and paper -- agreement, and the total agreed on:")
    print(f"  {'subject':22} {'p':>2} {'papers':>6} {'agree':>6}  {'total':>6}  verdict")
    for (subj, pno), entries in sorted(cohort.items()):
        counts = Counter(total for _, total in entries)
        mode, hits = counts.most_common(1)[0]
        share = hits / len(entries)
        ok = share >= COHORT_AGREEMENT
        print(f"  {subj:22} {pno:>2} {len(entries):>6} {share:>5.0%}  {mode:>6}  "
              f"{'write' if ok else 'hold'}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="write total_marks (default is a dry run)")
    parser.add_argument("--subject", help="restrict to one subject code, e.g. 0606")
    parser.add_argument("--limit", type=int, help="process at most this many papers")
    args = parser.parse_args(argv)
    return run(apply=args.apply, subject=args.subject, limit=args.limit)


if __name__ == "__main__":
    sys.exit(main())
