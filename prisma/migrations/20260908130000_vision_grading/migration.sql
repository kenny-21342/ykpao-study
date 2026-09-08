-- Support vision-based grading of diagram/drawing answers, as an alternative
-- to OCR-then-text-grade for questions where OCR has nothing useful to
-- extract (a graph, circuit, or geometric construction is not text).
--
-- Hand-written, like every migration here: the production database carries
-- deliberate drift that schema.prisma cannot express -- rag_chunks."searchVector"
-- is GENERATED ALWAYS ... STORED, and two indexes use gin_trgm_ops -- so
-- `prisma migrate dev` would offer to drop them.
--
-- Widening only: three columns with defaults, one on each attempt/question
-- table. Existing rows default to "text" grading, which is what actually
-- graded them.

ALTER TABLE "bank_questions"
    ADD COLUMN "requiresDiagram" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "past_paper_attempts"
    ADD COLUMN "gradingMode" TEXT NOT NULL DEFAULT 'text';

ALTER TABLE "mock_exam_items"
    ADD COLUMN "gradingMode" TEXT NOT NULL DEFAULT 'text';

ALTER TABLE "bank_question_attempts"
    ADD COLUMN "gradingMode" TEXT NOT NULL DEFAULT 'text';
