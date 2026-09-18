"""
Database layer: schema, connection, helpers.

Key fixes vs. old schema:
  - questions.doc_type  — distinguishes QP ('qp') from mark-scheme ('ms') rows
  - papers.filepath UNIQUE (was filename UNIQUE) — fixes year-collision dedup
  - question_images table — proper many-to-many image linkage (was comma-CSV in one column)
"""
import sqlite3
from typing import Optional
from .config import DB_FILE


def get_connection(db_file: str = DB_FILE) -> sqlite3.Connection:
    conn = sqlite3.connect(db_file, timeout=30.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    """Create all tables if missing. Safe to call repeatedly."""
    # First: create tables WITHOUT doc_type-dependent indexes
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS subjects (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            code  TEXT UNIQUE NOT NULL,
            name  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS papers (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_id    INTEGER NOT NULL,
            year          INTEGER NOT NULL,
            session       TEXT NOT NULL,
            paper_number  INTEGER NOT NULL,
            variant       INTEGER DEFAULT 0,
            doc_type      TEXT NOT NULL,          -- qp | ms | in
            filename      TEXT NOT NULL,
            filepath      TEXT UNIQUE NOT NULL,   -- UNIQUE on path, not filename
            file_hash     TEXT,
            total_marks   INTEGER DEFAULT 0,
            insert_text   TEXT DEFAULT '',
            processed_at  TEXT,
            FOREIGN KEY (subject_id) REFERENCES subjects(id)
        );

        CREATE TABLE IF NOT EXISTS questions (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            paper_id     INTEGER NOT NULL,
            number       INTEGER NOT NULL,
            part         TEXT DEFAULT '',
            sub_part     TEXT DEFAULT '',
            content      TEXT NOT NULL,
            latex        TEXT DEFAULT '',
            marks        INTEGER DEFAULT 0,
            has_diagram  INTEGER DEFAULT 0,
            diagram_ref  TEXT DEFAULT '',         -- legacy CSV (kept for compat)
            ordering     INTEGER DEFAULT 0,
            FOREIGN KEY (paper_id) REFERENCES papers(id)
        );

        CREATE TABLE IF NOT EXISTS question_images (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            question_id   INTEGER NOT NULL,
            image_path    TEXT NOT NULL,          -- relative to extracted_images/
            page_number   INTEGER,
            bbox_x0       REAL,
            bbox_y0       REAL,
            bbox_x1       REAL,
            bbox_y1       REAL,
            FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_question_images_qid ON question_images(question_id);
        CREATE INDEX IF NOT EXISTS idx_questions_paper ON questions(paper_id);
        CREATE INDEX IF NOT EXISTS idx_questions_num ON questions(number, part, sub_part);
        """
    )
    # Migration: add doc_type column to pre-existing databases (BEFORE indexing it)
    try:
        conn.execute("ALTER TABLE questions ADD COLUMN doc_type TEXT NOT NULL DEFAULT 'qp'")
    except sqlite3.OperationalError:
        pass  # Column already exists
    # Now create doc_type indexes (safe — column guaranteed to exist)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_questions_doc_type ON questions(doc_type)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_questions_paper_doc ON questions(paper_id, doc_type)")
    conn.commit()


def get_or_create_subject(conn: sqlite3.Connection, code: str, name: str) -> int:
    """Get or create a subject by its code. Uses canonical name."""
    from .config import get_subject_name

    canonical = get_subject_name(code) or name
    row = conn.execute("SELECT id FROM subjects WHERE code = ?", (code,)).fetchone()
    if row:
        return row[0]
    cur = conn.execute(
        "INSERT INTO subjects (code, name) VALUES (?, ?)", (code, canonical)
    )
    return cur.lastrowid
