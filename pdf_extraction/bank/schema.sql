-- V4 question bank — local extraction store.
--
-- SQLite is the working store because the pipeline is long-running, highly
-- concurrent on reads, and must survive network loss; a single merge step
-- promotes finished rows to Neon Postgres. The v1 tables (papers, questions)
-- are deliberately left alone as an archive.
--
-- Two rules shape this schema:
--   1. One row in bank_questions per ROOT question. Sub-parts never become
--      their own rows; they live inside body_md and are summarised in parts.
--   2. Nothing is ever discarded. Anything suspect gets a row in
--      bank_review_flags and status='needs_review', but it still exists.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS bank_subjects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    board       TEXT    NOT NULL,              -- CAIE | IB
    code        TEXT    NOT NULL,              -- 9709, or an IB subject slug
    name        TEXT    NOT NULL,
    level       TEXT,                          -- igcse | a-level | HL | SL
    UNIQUE (board, code, level)
);

CREATE TABLE IF NOT EXISTS bank_papers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id    INTEGER NOT NULL REFERENCES bank_subjects(id),
    board         TEXT    NOT NULL,
    year          INTEGER NOT NULL,
    session       TEXT    NOT NULL,            -- s | w | m, or May | November
    paper_number  INTEGER NOT NULL,
    variant       INTEGER NOT NULL DEFAULT 0,
    timezone      TEXT,                        -- IB TZ1 / TZ2
    doc_type      TEXT    NOT NULL,            -- qp | ms | in
    source_path   TEXT    NOT NULL UNIQUE,
    source_sha256 TEXT    NOT NULL,
    page_count    INTEGER NOT NULL DEFAULT 0,
    -- How stage 1 read this document: prose | ms_table | answer_key.
    span_strategy TEXT,
    used_ocr      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bank_papers_subject ON bank_papers(subject_id);
CREATE INDEX IF NOT EXISTS idx_bank_papers_identity
    ON bank_papers(board, year, session, paper_number, variant, doc_type);
CREATE INDEX IF NOT EXISTS idx_bank_papers_sha ON bank_papers(source_sha256);

CREATE TABLE IF NOT EXISTS bank_questions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    paper_id        INTEGER NOT NULL REFERENCES bank_papers(id) ON DELETE CASCADE,
    root_number     INTEGER NOT NULL,
    -- The whole question as Markdown + LaTeX, with ![](asset:figN)
    -- placeholders for figures and inline <table> for tables.
    body_md         TEXT    NOT NULL,
    -- JSON [{"label": "a(i)", "marks": 3}] — for marks accounting and
    -- part-level filtering only. Never a substitute for rows.
    parts           TEXT    NOT NULL DEFAULT '[]',
    total_marks     INTEGER,
    -- Full-page-strip render of the question, always present, so the
    -- interface can show the original even when transcription is poor.
    screenshot_id   INTEGER REFERENCES bank_assets(id),
    page_start      INTEGER,
    page_end        INTEGER,
    confidence      REAL    NOT NULL DEFAULT 0,
    status          TEXT    NOT NULL DEFAULT 'needs_review',  -- published | needs_review
    -- Difficulty from stage 4; source records whether a human or student
    -- data has since overridden the model's estimate.
    difficulty      INTEGER,
    difficulty_source TEXT,                    -- llm | empirical | manual
    difficulty_rationale TEXT,
    -- Provenance of the run that produced this row.
    run_id          TEXT,
    model           TEXT,
    prompt_version  TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (paper_id, root_number)
);

CREATE INDEX IF NOT EXISTS idx_bank_questions_paper ON bank_questions(paper_id);
CREATE INDEX IF NOT EXISTS idx_bank_questions_status ON bank_questions(status);
CREATE INDEX IF NOT EXISTS idx_bank_questions_difficulty ON bank_questions(difficulty);

CREATE TABLE IF NOT EXISTS bank_mark_schemes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id   INTEGER UNIQUE REFERENCES bank_questions(id) ON DELETE CASCADE,
    paper_id      INTEGER NOT NULL REFERENCES bank_papers(id) ON DELETE CASCADE,
    root_number   INTEGER NOT NULL,
    answer_md     TEXT    NOT NULL,
    -- JSON [{"mark_code": "M1", "marks": 1, "text": "...",
    --        "alternatives": [...]}]
    marking_points TEXT   NOT NULL DEFAULT '[]',
    total_marks   INTEGER,
    -- Set for multiple-choice papers, where the whole mark scheme is a
    -- single letter and no model call was needed.
    answer_letter TEXT,
    confidence    REAL    NOT NULL DEFAULT 0,
    status        TEXT    NOT NULL DEFAULT 'needs_review',
    run_id        TEXT,
    model         TEXT,
    prompt_version TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE (paper_id, root_number)
);

CREATE INDEX IF NOT EXISTS idx_bank_ms_question ON bank_mark_schemes(question_id);

CREATE TABLE IF NOT EXISTS bank_assets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256       TEXT    NOT NULL UNIQUE,
    kind         TEXT    NOT NULL,             -- figure | table | screenshot
    relative_path TEXT   NOT NULL,             -- assets/sha256/<ab>/<sha>.png
    width        INTEGER,
    height       INTEGER,
    byte_size    INTEGER,
    -- Crop provenance, so any asset can be traced back to the exact
    -- rectangle of the exact page it came from.
    source_page  INTEGER,
    bbox         TEXT,                         -- JSON [x0, y0, x1, y1]
    source_dpi   INTEGER NOT NULL DEFAULT 200,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_question_assets (
    question_id  INTEGER NOT NULL REFERENCES bank_questions(id) ON DELETE CASCADE,
    asset_id     INTEGER NOT NULL REFERENCES bank_assets(id),
    -- The placeholder the model was given and used in body_md, e.g. "fig1".
    placeholder  TEXT    NOT NULL,
    ordering     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (question_id, placeholder)
);

CREATE TABLE IF NOT EXISTS bank_mark_scheme_assets (
    mark_scheme_id INTEGER NOT NULL REFERENCES bank_mark_schemes(id) ON DELETE CASCADE,
    asset_id       INTEGER NOT NULL REFERENCES bank_assets(id),
    placeholder    TEXT   NOT NULL,
    ordering       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (mark_scheme_id, placeholder)
);

-- The rendered crop, in reading order.
--
-- bank_questions.screenshot_id holds only the first strip, which is all a
-- transcription-first bank ever needed. Measured over 490 questions, 89% render
-- as two or more strips and one needs 29, so in crop-first mode that column
-- shows a student the top fragment of nine questions in ten. These tables carry
-- the whole crop; screenshot_id stays as a pointer to strip 0.
CREATE TABLE IF NOT EXISTS bank_question_strips (
    question_id INTEGER NOT NULL REFERENCES bank_questions(id) ON DELETE CASCADE,
    asset_id    INTEGER NOT NULL REFERENCES bank_assets(id),
    ordering    INTEGER NOT NULL,
    page        INTEGER NOT NULL,
    PRIMARY KEY (question_id, ordering)
);

CREATE TABLE IF NOT EXISTS bank_mark_scheme_strips (
    mark_scheme_id INTEGER NOT NULL REFERENCES bank_mark_schemes(id) ON DELETE CASCADE,
    asset_id       INTEGER NOT NULL REFERENCES bank_assets(id),
    ordering       INTEGER NOT NULL,
    page           INTEGER NOT NULL,
    PRIMARY KEY (mark_scheme_id, ordering)
);

-- Syllabus-canonical topics, for filtering that matches the course outline.
CREATE TABLE IF NOT EXISTS bank_topics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id  INTEGER NOT NULL REFERENCES bank_subjects(id),
    code        TEXT,                          -- syllabus reference, e.g. "3.2"
    name        TEXT    NOT NULL,
    UNIQUE (subject_id, name)
);

CREATE TABLE IF NOT EXISTS bank_question_topics (
    question_id INTEGER NOT NULL REFERENCES bank_questions(id) ON DELETE CASCADE,
    topic_id    INTEGER NOT NULL REFERENCES bank_topics(id),
    confidence  REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (question_id, topic_id)
);

-- Free-form tags, the vocabulary students actually search by
-- ("maclaurin-series", "electromagnetism", "cell-structure").
CREATE TABLE IF NOT EXISTS bank_tags (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    slug   TEXT NOT NULL UNIQUE,
    label  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_question_tags (
    question_id INTEGER NOT NULL REFERENCES bank_questions(id) ON DELETE CASCADE,
    tag_id      INTEGER NOT NULL REFERENCES bank_tags(id),
    confidence  REAL    NOT NULL DEFAULT 0,
    PRIMARY KEY (question_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_bank_question_tags_tag ON bank_question_tags(tag_id);

-- Advisory QA. A flag never blocks a write; it routes the row to review.
CREATE TABLE IF NOT EXISTS bank_review_flags (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id INTEGER REFERENCES bank_questions(id) ON DELETE CASCADE,
    paper_id    INTEGER REFERENCES bank_papers(id) ON DELETE CASCADE,
    issue_type  TEXT    NOT NULL,   -- marks_mismatch | latex_invalid | ...
    severity    TEXT    NOT NULL,   -- low | medium | high
    message     TEXT    NOT NULL,
    evidence    TEXT,               -- JSON
    status      TEXT    NOT NULL DEFAULT 'open',  -- open | resolved | dismissed
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bank_flags_question ON bank_review_flags(question_id);
CREATE INDEX IF NOT EXISTS idx_bank_flags_open ON bank_review_flags(status, issue_type);

-- Per-question resume ledger. Keyed on everything that would change the
-- output, so a prompt or model change re-runs only what it affects and an
-- interrupted run resumes exactly where it stopped.
CREATE TABLE IF NOT EXISTS bank_run_ledger (
    work_key     TEXT PRIMARY KEY,   -- sha256(source + span + model + prompt)
    stage        TEXT NOT NULL,      -- transcribe | tag
    source_sha256 TEXT NOT NULL,
    root_number  INTEGER,
    status       TEXT NOT NULL,      -- ok | failed
    detail       TEXT,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bank_ledger_source ON bank_run_ledger(source_sha256);
CREATE INDEX IF NOT EXISTS idx_bank_ledger_status ON bank_run_ledger(status, stage);
