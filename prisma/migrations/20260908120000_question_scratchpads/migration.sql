-- Persist a student's scratch/working-out drawing per question, across all
-- three question-taking surfaces (mock exam, practice, bank).
--
-- Hand-written, like every migration here: the production database carries
-- deliberate drift that schema.prisma cannot express -- rag_chunks."searchVector"
-- is GENERATED ALWAYS ... STORED, and two indexes use gin_trgm_ops -- so
-- `prisma migrate dev` would offer to drop them.
--
-- A scratchpad must be able to exist before any attempt row does (autosaved
-- while the student is still working), and is shared across three separate
-- question tables that each have their own attempt table -- the same
-- constraint MockExamItem already carries, extended with a third nullable
-- ref since a scratchpad can also be scoped to one item within a specific
-- mock exam attempt rather than the underlying question bank. Exactly one of
-- the three is set per row; Postgres treats NULLs as distinct, so the three
-- partial-by-nature unique indexes below coexist without conflict.

CREATE TABLE "question_scratchpads" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pastPaperQuestionId" INTEGER,
    "bankQuestionId" INTEGER,
    "mockExamItemId" TEXT,
    "strokesJson" JSONB NOT NULL,
    "previewImageUrl" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "question_scratchpads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "question_scratchpads_userId_pastPaperQuestionId_key"
    ON "question_scratchpads"("userId", "pastPaperQuestionId");

CREATE UNIQUE INDEX "question_scratchpads_userId_bankQuestionId_key"
    ON "question_scratchpads"("userId", "bankQuestionId");

CREATE UNIQUE INDEX "question_scratchpads_userId_mockExamItemId_key"
    ON "question_scratchpads"("userId", "mockExamItemId");

CREATE INDEX "question_scratchpads_userId_idx"
    ON "question_scratchpads"("userId");

ALTER TABLE "question_scratchpads"
    ADD CONSTRAINT "question_scratchpads_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "question_scratchpads"
    ADD CONSTRAINT "question_scratchpads_pastPaperQuestionId_fkey"
    FOREIGN KEY ("pastPaperQuestionId") REFERENCES "past_paper_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "question_scratchpads"
    ADD CONSTRAINT "question_scratchpads_bankQuestionId_fkey"
    FOREIGN KEY ("bankQuestionId") REFERENCES "bank_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "question_scratchpads"
    ADD CONSTRAINT "question_scratchpads_mockExamItemId_fkey"
    FOREIGN KEY ("mockExamItemId") REFERENCES "mock_exam_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Mirrors PastPaperAttempt.answerImageUrl / MockExamItem.answerImageUrl --
-- BankQuestionAttempt was missing this column entirely, so a bank question's
-- drawn/photographed answer had nowhere to be recorded.
ALTER TABLE "bank_question_attempts"
    ADD COLUMN "answerImageUrl" TEXT;
