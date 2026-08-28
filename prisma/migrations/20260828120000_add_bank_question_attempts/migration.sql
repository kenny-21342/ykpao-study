-- Attempts against a crop-first bank question.
--
-- Hand-written, like every migration here: the production database carries
-- deliberate drift that schema.prisma cannot express -- rag_chunks."searchVector"
-- is GENERATED ALWAYS ... STORED, and two indexes use gin_trgm_ops -- so
-- `prisma migrate dev` would offer to drop them. Purely additive: one table,
-- two indexes, two foreign keys.
--
-- A fourth attempt table because a foreign key can only point at one of the
-- three question tables. Until this existed the bank had no attempt path, so
-- the dashboard's "Questions Answered" tile was pinned at zero by the schema.

CREATE TABLE "bank_question_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" INTEGER NOT NULL,
    "answer" TEXT NOT NULL,
    -- Nullable on purpose: NULL means nothing could mark it (free response with
    -- no answer key), which is not the same as FALSE, meaning marked and wrong.
    "isCorrect" BOOLEAN,
    "score" DOUBLE PRECISION,
    -- key | self | ai
    "gradedBy" TEXT NOT NULL,
    "timeSpent" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_question_attempts_pkey" PRIMARY KEY ("id")
);

-- No unique constraint: re-attempting a question is the point, and the
-- dashboard accuracy tile reads the whole history for one user, newest first.
CREATE INDEX "bank_question_attempts_userId_createdAt_idx"
    ON "bank_question_attempts"("userId", "createdAt");

-- "How did people do on this question" reads by question.
CREATE INDEX "bank_question_attempts_questionId_idx"
    ON "bank_question_attempts"("questionId");

ALTER TABLE "bank_question_attempts"
    ADD CONSTRAINT "bank_question_attempts_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bank_question_attempts"
    ADD CONSTRAINT "bank_question_attempts_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "bank_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
