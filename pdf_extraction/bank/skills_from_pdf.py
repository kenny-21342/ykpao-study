"""Read command terms out of the source PDFs, because the bank has no text.

Stage 4 computes `skills` from a question's transcription. The corpus is
crop-only: all 66,756 published questions have an empty `body_md`, and the only
text anywhere in the bank is 25,060 single-letter answer keys. So the backfill
this was written for had nothing to read, and reported every subject as 100%
untagged.

The text does exist, one layer down. The question papers are on disk and carry a
real text layer -- of 6,823 question papers exactly one needed OCR -- so the
command terms can be read from the PDF at no API cost and without waiting for
the paid transcription pass.

Measured against the 132 questions that do have a transcription, using the terms
from their real text as ground truth:

    recall, whole page span          316/316   (100%)
    recall, sliced to the question    313/316   (99%)
    extra terms from the slice        0.13 per question
    exact set match                   87/99     (87%)

The slice is worth the 1% recall it costs: a page usually carries more than one
question, and without it every question on a page inherits its neighbours' verbs
-- which is exactly the false signal the per-term accuracy panel must not show.
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path

import fitz

from .tag import extract_command_words


@dataclass(frozen=True)
class ExtractedSkills:
    """What one question yielded, and how."""

    terms: list[str]
    #: 'sliced' when the printed question number was found in the page text,
    #: 'page' when the whole span was used as a fallback. Reported so a run can
    #: be judged rather than trusted.
    strategy: str


def page_text(document: fitz.Document, page_start: int | None, page_end: int | None) -> str:
    """The text of the pages a question spans, 1-indexed and clamped."""
    first = max(1, page_start or 1)
    last = min(document.page_count, page_end or first)
    if last < first:
        last = first
    return "\n".join(document[index - 1].get_text() for index in range(first, last + 1))


def slice_to_question(text: str, root_number: int) -> tuple[str, bool]:
    """Cut page text down to one question, using the printed numbering.

    Returns the slice and whether the question's own number was found. A page
    holds several questions, so without this a question inherits the command
    words of whatever sits above and below it on the page.

    The number is matched only at the start of a line and only when followed by
    a capital or an opening bracket, which is how a root number is printed. That
    avoids cutting at a mark total, a page number, or a figure label.
    """
    start = re.search(rf"(?m)^\s*{root_number}\s*(?=[A-Z(])", text)
    begin = start.start() if start else 0
    following = re.search(rf"(?m)^\s*{root_number + 1}\s*(?=[A-Z(])", text[begin:])
    end = begin + following.start() if following else len(text)
    return text[begin:end], start is not None


def skills_for_question(
    document: fitz.Document,
    root_number: int,
    page_start: int | None,
    page_end: int | None,
) -> ExtractedSkills:
    text = page_text(document, page_start, page_end)
    sliced, found = slice_to_question(text, root_number)
    return ExtractedSkills(terms=extract_command_words(sliced), strategy='sliced' if found else 'page')


def published_questions(connection: sqlite3.Connection, subject_code: str | None = None):
    """Every published question, with the paper it was cut from."""
    sql = """
        SELECT q.id, q.root_number, q.page_start, q.page_end,
               p.source_path, s.code AS subject_code
        FROM bank_questions q
        JOIN bank_papers p ON p.id = q.paper_id
        JOIN bank_subjects s ON s.id = p.subject_id
        WHERE q.status = 'published' AND p.doc_type = 'qp'
    """
    params: tuple = ()
    if subject_code:
        sql += " AND s.code = ?"
        params = (subject_code,)
    return connection.execute(sql + " ORDER BY p.source_path, q.root_number", params)


def missing_sources(connection: sqlite3.Connection) -> list[str]:
    """Source PDFs the store references that are not on this machine."""
    rows = connection.execute(
        "SELECT DISTINCT source_path FROM bank_papers WHERE doc_type = 'qp'"
    ).fetchall()
    return [row[0] for row in rows if not Path(row[0]).exists()]
