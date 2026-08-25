"""Persistence for the v4 extraction store.

Everything the pipeline produces lands in SQLite here. Writes are idempotent on
the natural keys — ``(paper_id, root_number)`` for questions, sha256 for assets
— so re-running a document updates rather than duplicates, and an interrupted
run can simply be restarted.

Nothing in this module is ever allowed to discard a row. QA flags are written
alongside the question and set its status; they never prevent the insert.
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

SCHEMA_PATH = Path(__file__).with_name("schema.sql")

# 9709_s21_qp_12.pdf -> code, session, year, doc type, paper+variant
_CAIE_FILENAME = re.compile(
    r"^(?P<code>\d{4})_(?P<session>[swm])(?P<year>\d{2})_"
    r"(?P<doc_type>qp|ms|in|sf|gt|ci|sp|tn)_(?P<paper>\d)(?P<variant>\d)?",
    re.IGNORECASE,
)

_SESSION_NAMES = {"s": "May-June", "w": "Oct-Nov", "m": "March"}


@dataclass(frozen=True)
class PaperIdentity:
    """Everything the filename tells us about a document."""

    code: str
    board: str
    year: int
    session: str
    paper_number: int
    variant: int
    doc_type: str

    @property
    def session_name(self) -> str:
        return _SESSION_NAMES.get(self.session, self.session)


def parse_caie_filename(path: Path | str) -> PaperIdentity | None:
    """Read a CAIE past-paper filename, or ``None`` if it is not one."""
    match = _CAIE_FILENAME.match(Path(path).stem)
    if not match:
        return None
    variant = match.group("variant")
    return PaperIdentity(
        code=match.group("code"),
        board="CAIE",
        year=2000 + int(match.group("year")),
        session=match.group("session").lower(),
        paper_number=int(match.group("paper")),
        variant=int(variant) if variant else 0,
        doc_type=match.group("doc_type").lower(),
    )


def connect(db_path: Path | str) -> sqlite3.Connection:
    """Open the store, creating the schema when the file is new."""
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(db_path), timeout=30.0)
    connection.row_factory = sqlite3.Row
    # Wait for a competing writer instead of failing the document outright.
    connection.execute("PRAGMA busy_timeout = 30000")
    connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    connection.commit()
    return connection


def upsert_subject(
    connection: sqlite3.Connection,
    *,
    board: str,
    code: str,
    name: str,
    level: str | None,
) -> int:
    row = connection.execute(
        "SELECT id FROM bank_subjects WHERE board = ? AND code = ? AND "
        "COALESCE(level, '') = COALESCE(?, '')",
        (board, code, level),
    ).fetchone()
    if row:
        return int(row["id"])
    cursor = connection.execute(
        "INSERT INTO bank_subjects (board, code, name, level) VALUES (?, ?, ?, ?)",
        (board, code, name, level),
    )
    return int(cursor.lastrowid)


def upsert_paper(
    connection: sqlite3.Connection,
    *,
    subject_id: int,
    identity: PaperIdentity,
    source_path: Path | str,
    source_sha256: str,
    page_count: int,
    span_strategy: str | None,
    used_ocr: bool,
) -> int:
    """Insert or refresh one document row, keyed on its source path."""
    source_path = str(source_path)
    row = connection.execute(
        "SELECT id FROM bank_papers WHERE source_path = ?", (source_path,)
    ).fetchone()
    if row:
        paper_id = int(row["id"])
        connection.execute(
            "UPDATE bank_papers SET source_sha256 = ?, page_count = ?, "
            "span_strategy = ?, used_ocr = ? WHERE id = ?",
            (source_sha256, page_count, span_strategy, int(used_ocr), paper_id),
        )
        return paper_id

    cursor = connection.execute(
        """
        INSERT INTO bank_papers
            (subject_id, board, year, session, paper_number, variant, timezone,
             doc_type, source_path, source_sha256, page_count, span_strategy, used_ocr)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
        """,
        (
            subject_id, identity.board, identity.year, identity.session,
            identity.paper_number, identity.variant, identity.doc_type,
            source_path, source_sha256, page_count, span_strategy, int(used_ocr),
        ),
    )
    return int(cursor.lastrowid)


def upsert_asset(connection: sqlite3.Connection, asset) -> int:
    """Store one asset row, deduplicated on its content hash."""
    row = connection.execute(
        "SELECT id FROM bank_assets WHERE sha256 = ?", (asset.sha256,)
    ).fetchone()
    if row:
        return int(row["id"])
    cursor = connection.execute(
        """
        INSERT INTO bank_assets
            (sha256, kind, relative_path, width, height, byte_size,
             source_page, bbox, source_dpi)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            asset.sha256, asset.kind, asset.relative_path, asset.width,
            asset.height, asset.byte_size, asset.source_page,
            json.dumps([round(v, 3) for v in asset.bbox]), asset.source_dpi,
        ),
    )
    return int(cursor.lastrowid)


def upsert_question(
    connection: sqlite3.Connection,
    *,
    paper_id: int,
    transcription,
    rendered_span,
    asset_ids: dict[str, int],
    tagging=None,
    run_id: str,
    model: str,
    prompt_version: str,
    status: str,
) -> int:
    """Write one root question and its asset links.

    ``asset_ids`` maps sha256 to ``bank_assets.id`` for assets already stored.
    """
    screenshot_sha = rendered_span.screenshot_sha256
    screenshot_id = asset_ids.get(screenshot_sha) if screenshot_sha else None

    difficulty = getattr(tagging, "difficulty", None) if tagging else None
    rationale = getattr(tagging, "difficulty_rationale", None) if tagging else None

    existing = connection.execute(
        "SELECT id FROM bank_questions WHERE paper_id = ? AND root_number = ?",
        (paper_id, int(transcription.root_number)),
    ).fetchone()

    values = (
        transcription.body_md,
        json.dumps(transcription.parts),
        transcription.total_marks,
        screenshot_id,
        rendered_span.page_start,
        rendered_span.page_end,
        transcription.confidence,
        status,
        difficulty,
        "llm" if difficulty is not None else None,
        rationale,
        run_id,
        model,
        prompt_version,
    )

    if existing:
        question_id = int(existing["id"])
        connection.execute(
            """
            UPDATE bank_questions SET
                body_md = ?, parts = ?, total_marks = ?, screenshot_id = ?,
                page_start = ?, page_end = ?, confidence = ?, status = ?,
                difficulty = ?, difficulty_source = ?, difficulty_rationale = ?,
                run_id = ?, model = ?, prompt_version = ?
            WHERE id = ?
            """,
            values + (question_id,),
        )
    else:
        cursor = connection.execute(
            """
            INSERT INTO bank_questions
                (paper_id, root_number, body_md, parts, total_marks, screenshot_id,
                 page_start, page_end, confidence, status, difficulty,
                 difficulty_source, difficulty_rationale, run_id, model, prompt_version)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (paper_id, int(transcription.root_number)) + values,
        )
        question_id = int(cursor.lastrowid)

    _link_question_assets(connection, question_id, rendered_span, asset_ids)
    if tagging is not None:
        _link_tags(connection, question_id, tagging)
    return question_id


def _link_question_assets(
    connection: sqlite3.Connection,
    question_id: int,
    rendered_span,
    asset_ids: dict[str, int],
) -> None:
    connection.execute(
        "DELETE FROM bank_question_assets WHERE question_id = ?", (question_id,)
    )
    for ordering, figure in enumerate(rendered_span.figures):
        asset_id = asset_ids.get(figure.get("sha256", ""))
        if asset_id is None:
            continue
        connection.execute(
            """
            INSERT OR REPLACE INTO bank_question_assets
                (question_id, asset_id, placeholder, ordering)
            VALUES (?, ?, ?, ?)
            """,
            (question_id, asset_id, figure["id"], ordering),
        )


def _link_tags(connection: sqlite3.Connection, question_id: int, tagging) -> None:
    connection.execute(
        "DELETE FROM bank_question_tags WHERE question_id = ?", (question_id,)
    )
    for slug in getattr(tagging, "tags", []) or []:
        row = connection.execute(
            "SELECT id FROM bank_tags WHERE slug = ?", (slug,)
        ).fetchone()
        if row:
            tag_id = int(row["id"])
        else:
            cursor = connection.execute(
                "INSERT INTO bank_tags (slug, label) VALUES (?, ?)",
                (slug, slug.replace("-", " ")),
            )
            tag_id = int(cursor.lastrowid)
        connection.execute(
            "INSERT OR REPLACE INTO bank_question_tags "
            "(question_id, tag_id, confidence) VALUES (?, ?, ?)",
            (question_id, tag_id, getattr(tagging, "confidence", 0.0)),
        )


def upsert_mark_scheme(
    connection: sqlite3.Connection,
    *,
    paper_id: int,
    transcription,
    question_id: int | None,
    run_id: str,
    model: str,
    prompt_version: str,
    status: str,
) -> int:
    root_number = int(transcription.root_number)
    values = (
        question_id,
        transcription.answer_md,
        json.dumps(transcription.marking_points),
        transcription.total_marks,
        transcription.answer_letter,
        transcription.confidence,
        status,
        run_id,
        model,
        prompt_version,
    )

    existing = connection.execute(
        "SELECT id FROM bank_mark_schemes WHERE paper_id = ? AND root_number = ?",
        (paper_id, root_number),
    ).fetchone()

    if existing:
        mark_scheme_id = int(existing["id"])
        connection.execute(
            """
            UPDATE bank_mark_schemes SET
                question_id = ?, answer_md = ?, marking_points = ?, total_marks = ?,
                answer_letter = ?, confidence = ?, status = ?, run_id = ?,
                model = ?, prompt_version = ?
            WHERE id = ?
            """,
            values + (mark_scheme_id,),
        )
        return mark_scheme_id

    cursor = connection.execute(
        """
        INSERT INTO bank_mark_schemes
            (paper_id, root_number, question_id, answer_md, marking_points,
             total_marks, answer_letter, confidence, status, run_id, model, prompt_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (paper_id, root_number) + values,
    )
    return int(cursor.lastrowid)


def record_answer_key(
    connection: sqlite3.Connection,
    *,
    paper_id: int,
    answer_key: tuple[tuple[int, str], ...],
    run_id: str,
) -> int:
    """Store a recovered multiple-choice key.

    These are fully recovered by stage 1, so they cost nothing and bypass the
    model entirely.
    """
    written = 0
    for root_number, letter in answer_key:
        connection.execute(
            """
            INSERT OR REPLACE INTO bank_mark_schemes
                (paper_id, root_number, answer_md, marking_points, total_marks,
                 answer_letter, confidence, status, run_id, model, prompt_version)
            VALUES (?, ?, ?, '[]', 1, ?, 1.0, 'published', ?, 'deterministic', 'answer-key-v1')
            """,
            (paper_id, root_number, letter, letter, run_id),
        )
        written += 1
    return written


def clear_paper_flags(connection: sqlite3.Connection, paper_id: int) -> None:
    """Drop a paper's open document-level flags before it is reprocessed.

    Flags raised against a paper rather than a question — numbering gaps, and
    anything on a mark scheme, which has no question row to hang from — would
    otherwise accumulate a duplicate set on every re-run.
    """
    connection.execute(
        "DELETE FROM bank_review_flags "
        "WHERE paper_id = ? AND question_id IS NULL AND status = 'open'",
        (paper_id,),
    )


def record_flags(
    connection: sqlite3.Connection,
    *,
    question_id: int | None,
    paper_id: int | None,
    flags,
) -> None:
    """Replace the open flags for one question."""
    if question_id is not None:
        connection.execute(
            "DELETE FROM bank_review_flags WHERE question_id = ? AND status = 'open'",
            (question_id,),
        )
    for flag in flags:
        connection.execute(
            """
            INSERT INTO bank_review_flags
                (question_id, paper_id, issue_type, severity, message, evidence, status)
            VALUES (?, ?, ?, ?, ?, ?, 'open')
            """,
            (
                question_id, paper_id, flag.issue_type, flag.severity, flag.message,
                json.dumps(flag.evidence) if flag.evidence is not None else None,
            ),
        )


def file_sha256(path: Path | str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def store_counts(connection: sqlite3.Connection) -> dict[str, int]:
    """Row counts per table, for run reporting."""
    tables = [
        "bank_subjects", "bank_papers", "bank_questions", "bank_mark_schemes",
        "bank_assets", "bank_question_assets", "bank_tags", "bank_question_tags",
        "bank_review_flags", "bank_run_ledger",
    ]
    counts: dict[str, int] = {}
    for table in tables:
        try:
            counts[table] = int(
                connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            )
        except sqlite3.Error:
            counts[table] = 0
    return counts
