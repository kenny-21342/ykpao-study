-- Past paper browser: browse taxonomy on subjects and papers.
-- All columns are added with defaults so existing rows migrate unchanged.

-- Subject: which board/qualification a subject belongs to.
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "board" TEXT NOT NULL DEFAULT 'CAIE';
ALTER TABLE "subjects" ADD COLUMN IF NOT EXISTS "qualification" TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS "subjects_board_qualification_idx"
  ON "subjects" ("board", "qualification");

-- PastPaper: IB identifies a sitting by level and timezone as well; both stay
-- empty for CAIE. paperCode keeps the raw token because IB papers such as "1A"
-- do not fit paperNumber's integer column.
ALTER TABLE "past_papers" ADD COLUMN IF NOT EXISTS "level" TEXT NOT NULL DEFAULT '';
ALTER TABLE "past_papers" ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT '';
ALTER TABLE "past_papers" ADD COLUMN IF NOT EXISTS "paperCode" TEXT NOT NULL DEFAULT '';
ALTER TABLE "past_papers" ADD COLUMN IF NOT EXISTS "pageCount" INTEGER;
ALTER TABLE "past_papers" ADD COLUMN IF NOT EXISTS "sizeBytes" INTEGER;

-- Serves the browse cascade (subject -> year -> series).
CREATE INDEX IF NOT EXISTS "past_papers_subjectId_year_session_idx"
  ON "past_papers" ("subjectId", "year", "session");

-- The legacy /api/papers/pdf route looks papers up by filename.
CREATE INDEX IF NOT EXISTS "past_papers_filename_idx"
  ON "past_papers" ("filename");
