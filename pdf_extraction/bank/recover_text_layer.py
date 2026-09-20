#!/usr/bin/env python3
"""Recover transcripts the model refused to produce, from the PDF's own text.

    python3 -m pdf_extraction.bank.recover_text_layer            # verify only
    python3 -m pdf_extraction.bank.recover_text_layer --apply

The vision model will not transcribe copyrighted literary material. Asked to
read a Jennings poem off a Literature paper it answers, in full and with a
200 OK, "Sorry, I can't provide a verbatim transcription of the copyrighted
poem shown in the image." The pipeline had no reason to distrust a 200, so it
wrote that sentence into `body_md` and logged the work as `ok`.

That is worse than a failure. A failed row retries; an `ok` row is finished
forever. And the sentence is ordinary English prose, so `hasGradableText()`
in the app returns true for it: a student answering one of these questions
would have their answer vision-graded against a refusal notice, which is the
confident-zero bug the F16 fix closed, coming back through another door.

No model can fix this, because no model is the problem -- retrying only earns
another refusal. But the source PDFs carry a real text layer, and the store
already knows exactly where every question sits: `bank_assets` keeps
`source_page` and a `bbox` for each strip the renderer cropped. Clipping the
page to that rectangle returns the question, poem included, with no model in
the loop, no spend, and no opinion about copyright.

Nine of the questions cannot be recovered by any means: CIE redacted them in
the published paper itself, so the page reads "Content removed due to
copyright restrictions." Those are flagged and blanked rather than filled --
an honest empty question is safe, since `hasGradableText()` then routes them
away from grading, and a wrong one is not.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

import fitz  # PyMuPDF

DB = Path(__file__).resolve().parent / "extract.db"

#: Prefixes the model's refusals take. Anchored at the start, because a
#: question may legitimately *discuss* being unable to do something -- an
#: unanchored match on "unable to" is what produced a false alarm from the
#: quality watcher on a question about a programmer who could not compile.
REFUSAL_PREFIXES = (
    "Sorry, I can",
    "I can't provide",
    "I can’t provide",
    "I cannot provide",
    "I'm unable to",
    "I’m unable to",
)

#: CIE's own redaction. Nothing behind it to recover.
REDACTED_MARKER = "content removed due to copyright"

#: Page furniture the clip picks up along with the question: the page number
#: on its own line, the syllabus/session footer, the copyright line and the
#: turn-over marker. Everything here is printed on every page of every paper,
#: so none of it is ever part of a question.
FURNITURE = (
    re.compile(r"^\s*©\s*UCLES\s+\d{4}\s*$", re.M),
    re.compile(r"^\s*\[?Turn over\]?\s*$", re.M),
    re.compile(r"^\s*\d{4}/\d{2}/[A-Z]/[A-Z]/\d{2}\s*$", re.M),
    re.compile(r"^\s*\d{1,3}\s*$", re.M),  # bare page number
    re.compile(r"^\s*Page\s+\d+\s+of\s+\d+\s*$", re.M | re.I),  # mark-scheme header
)


def sql_refusal_filter(column: str) -> str:
    """A LIKE filter matching the refusal prefixes, for `column`."""
    # `LIKE` is case-insensitive for ASCII in SQLite, which is what we want:
    # the model has produced both "Sorry" and "sorry".
    clauses = " or ".join(f"{column} like ?" for _ in REFUSAL_PREFIXES)
    return f"({clauses})"


def refusal_params() -> list[str]:
    return [f"{p}%" for p in REFUSAL_PREFIXES]


def clean(text: str) -> str:
    """Strip page furniture and collapse the blank lines it leaves behind."""
    for pattern in FURNITURE:
        text = pattern.sub("", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


class Pdfs:
    """Opened documents, kept around: a paper holds many questions."""

    def __init__(self) -> None:
        self._open: dict[str, fitz.Document] = {}

    def page_text(self, path: str, page: int, bbox: str) -> str:
        doc = self._open.get(path)
        if doc is None:
            doc = self._open[path] = fitz.open(path)
        rect = fitz.Rect(*json.loads(bbox))
        return doc[page - 1].get_text(clip=rect).strip()

    def close(self) -> None:
        for doc in self._open.values():
            doc.close()


def recover_questions(db: sqlite3.Connection, pdfs: Pdfs) -> list[dict]:
    rows = db.execute(
        f"""
        select q.id, p.source_path, a.source_page, a.bbox
          from bank_questions q
          join bank_papers p on p.id = q.paper_id
          left join bank_assets a on a.id = q.screenshot_id
         where {sql_refusal_filter('q.body_md')}
      order by q.id
        """,
        refusal_params(),
    ).fetchall()

    out = []
    for row in rows:
        if not row["bbox"]:
            out.append({"id": row["id"], "verdict": "no-bbox", "text": ""})
            continue
        text = clean(pdfs.page_text(row["source_path"], row["source_page"], row["bbox"]))
        out.append({"id": row["id"], "text": text, "verdict": verdict(text)})
    return out


def recover_mark_schemes(db: sqlite3.Connection, pdfs: Pdfs) -> list[dict]:
    """Mark schemes have no single screenshot, but their strips do.

    Joining the strips back in reading order reconstructs the whole scheme --
    which is why all 104 of them recover where 25 of 34 questions do: a mark
    scheme quotes no poem, so CIE never redacts one.
    """
    rows = db.execute(
        f"""
        select m.id, m.question_id, p.source_path,
               (select group_concat(a.source_page || '|' || a.bbox, ';;')
                  from bank_mark_scheme_strips s
                  join bank_assets a on a.id = s.asset_id
                 where s.mark_scheme_id = m.id) as strips
          from bank_mark_schemes m
          join bank_papers p on p.id = m.paper_id
         where {sql_refusal_filter('m.answer_md')}
      order by m.id
        """,
        refusal_params(),
    ).fetchall()

    out = []
    for row in rows:
        if not row["strips"]:
            out.append({"id": row["id"], "question_id": row["question_id"],
                        "verdict": "no-bbox", "text": ""})
            continue
        parts = []
        for chunk in row["strips"].split(";;"):
            page, bbox = chunk.split("|", 1)
            parts.append(pdfs.page_text(row["source_path"], int(page), bbox))
        text = clean("\n".join(p for p in parts if p))
        out.append({"id": row["id"], "question_id": row["question_id"],
                    "text": text, "verdict": verdict(text)})
    return out


def verdict(text: str) -> str:
    if REDACTED_MARKER in text.lower():
        return "redacted"
    if len(text) < 60:
        return "thin"
    return "recovered"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true",
                        help="write the recovered text back (default: verify only)")
    parser.add_argument("--db", default=str(DB))
    args = parser.parse_args()

    db = sqlite3.connect(args.db)
    db.row_factory = sqlite3.Row
    pdfs = Pdfs()

    questions = recover_questions(db, pdfs)
    schemes = recover_mark_schemes(db, pdfs)
    pdfs.close()

    for label, rows in (("questions", questions), ("mark schemes", schemes)):
        counts: dict[str, int] = {}
        for r in rows:
            counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
        summary = ", ".join(f"{v} {k}" for k, v in sorted(counts.items())) or "none"
        print(f"{label:13} {len(rows):4}  ({summary})")

    if not args.apply:
        print("\nverify only — re-run with --apply to write")
        return 0

    written = blanked = 0
    for r in questions:
        if r["verdict"] == "recovered":
            db.execute(
                "update bank_questions set body_md = ?, model = 'pdf-text-layer' where id = ?",
                (r["text"], r["id"]),
            )
            written += 1
        else:
            # Blank, not left as a refusal: an empty body is routed away from
            # grading by hasGradableText(), a refusal notice is not.
            db.execute(
                "update bank_questions set body_md = '', status = 'needs_review' where id = ?",
                (r["id"],),
            )
            db.execute(
                "insert or replace into bank_transcript_flags "
                "(question_id, side, reason, detail) values (?, 'question', ?, ?)",
                (r["id"], "unrecoverable-copyright",
                 "redacted in the source paper by CIE" if r["verdict"] == "redacted"
                 else f"no text recovered ({r['verdict']})"),
            )
            blanked += 1

    for r in schemes:
        if r["verdict"] == "recovered":
            db.execute(
                "update bank_mark_schemes set answer_md = ?, model = 'pdf-text-layer' where id = ?",
                (r["text"], r["id"]),
            )
            written += 1
        else:
            db.execute("update bank_mark_schemes set answer_md = '' where id = ?", (r["id"],))
            db.execute(
                "insert or replace into bank_transcript_flags "
                "(question_id, side, reason, detail) values (?, 'mark_scheme', ?, ?)",
                (r["question_id"], "unrecoverable-copyright", f"no text recovered ({r['verdict']})"),
            )
            blanked += 1

    db.commit()
    print(f"\napplied: {written} recovered from the text layer, {blanked} blanked and flagged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
