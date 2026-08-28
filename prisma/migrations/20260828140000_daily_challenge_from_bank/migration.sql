-- Let the daily challenge draw from the crop-first bank.
--
-- Hand-written, like every migration here: the production database carries
-- deliberate drift that schema.prisma cannot express -- rag_chunks."searchVector"
-- is GENERATED ALWAYS ... STORED, and two indexes use gin_trgm_ops -- so
-- `prisma migrate dev` would offer to drop them.
--
-- The picker read the first 500 rows of `past_paper_questions`, a table holding
-- a few dozen rows per subject for three subjects. The bank holds 66,758
-- published questions, 24,356 of them with a stored answer key -- which is what
-- lets the challenge mark an answer instantly instead of waiting on a model.
--
-- Widening only: "questionId" becomes nullable and a nullable column is added,
-- so every existing attempt stays valid and nothing is backfilled or dropped.

ALTER TABLE "daily_challenge_attempts"
    ALTER COLUMN "questionId" DROP NOT NULL;

ALTER TABLE "daily_challenge_attempts"
    ADD COLUMN "bankQuestionId" INTEGER;

ALTER TABLE "daily_challenge_attempts"
    ADD CONSTRAINT "daily_challenge_attempts_bankQuestionId_fkey"
    FOREIGN KEY ("bankQuestionId") REFERENCES "bank_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An attempt points at exactly one corpus, never both and never neither.
ALTER TABLE "daily_challenge_attempts"
    ADD CONSTRAINT "daily_challenge_attempts_one_question_source"
    CHECK (("questionId" IS NULL) <> ("bankQuestionId" IS NULL));

CREATE INDEX "daily_challenge_attempts_bankQuestionId_idx"
    ON "daily_challenge_attempts"("bankQuestionId");
