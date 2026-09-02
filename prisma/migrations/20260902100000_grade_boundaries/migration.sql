-- Grade boundaries, so a mark can become a grade.
--
-- Hand-written, like every migration here: the production database carries
-- deliberate drift that schema.prisma cannot express -- rag_chunks."searchVector"
-- is GENERATED ALWAYS ... STORED, and two indexes use gin_trgm_ops -- so
-- `prisma migrate dev` would offer to drop them.
--
-- Until now the grade on a finished mock exam was computed in the browser from
-- a fixed percentage ladder: >=70 A, >=60 B, >=50 C, >=40 D, else E
-- (`app/components/MockExams.tsx`). That is wrong twice over. It ignores the
-- real thresholds, which move every session and sit far below 70% in most
-- subjects; and it hands an IB student a letter, when every IB subject is
-- graded 1-7.
--
-- `source` is the honest part. CAIE publishes grade thresholds per session, so
-- those rows are `published`. The IB does not publish them -- schools receive
-- them -- so those arrive by admin upload as `school`, and anything else is an
-- `estimate` that the UI must label as one. A student choosing a university
-- offer on an inflated predicted grade is the failure this column exists to
-- prevent.
--
-- New table only; nothing existing is touched.

CREATE TABLE IF NOT EXISTS "grade_boundaries" (
    "id"          SERIAL PRIMARY KEY,
    "board"       TEXT NOT NULL,
    "subjectCode" TEXT NOT NULL,
    "level"       TEXT,
    "year"        INTEGER,
    "session"     TEXT,
    -- Null means the row applies to the whole subject rather than one paper.
    -- Most published CAIE thresholds are per paper; a fallback band is not.
    "paperNumber" INTEGER,
    "grade"       TEXT NOT NULL,
    "minMark"     INTEGER NOT NULL,
    "totalMarks"  INTEGER NOT NULL,
    "source"      TEXT NOT NULL DEFAULT 'estimate',
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL
);

-- One row per grade per identified paper. NULLs are distinct in Postgres, so
-- this does not constrain the subject-wide fallback rows against each other;
-- the seed is responsible for not duplicating those.
CREATE UNIQUE INDEX IF NOT EXISTS "grade_boundaries_identity_key"
    ON "grade_boundaries"("board", "subjectCode", "level", "year", "session", "paperNumber", "grade");

-- The lookup is always "this subject, most recent session first".
CREATE INDEX IF NOT EXISTS "grade_boundaries_lookup_idx"
    ON "grade_boundaries"("board", "subjectCode", "year" DESC);
