-- Record what the student awarded themselves, separately from the score.
--
-- Apply by hand, like every migration here. Do NOT run `prisma migrate deploy`
-- / `migrate dev` / `db push`: production carries drift schema.prisma cannot
-- express (rag_chunks."searchVector" is GENERATED ALWAYS ... STORED, two
-- indexes use gin_trgm_ops), and _prisma_migrations does not match this folder.
-- Every statement is idempotent.
--
-- `score` is a fraction of the marks available, which is what the analytics
-- read, and it cannot answer "did this student mark themselves fairly" because
-- once stored it no longer says who did the marking or out of what. These two
-- columns keep both readings of the same attempt:
--
--   selfAwardedScore   marks the student gave themselves
--   authoritativeScore marks a key or the model gave for that same attempt
--
-- Where both are present the difference is the student's marking bias, which is
-- worth showing them: a student who awards themselves two marks more than the
-- scheme does on every 6-mark question is not learning from marking their work,
-- and nothing else in the product can see it.
--
-- Both nullable, and neither is written for the common case where an attempt
-- was only ever marked one way. Widening only.

ALTER TABLE "bank_question_attempts"
    ADD COLUMN IF NOT EXISTS "selfAwardedScore" DOUBLE PRECISION;

ALTER TABLE "bank_question_attempts"
    ADD COLUMN IF NOT EXISTS "authoritativeScore" DOUBLE PRECISION;

-- Marks awarded, not the fraction: a student thinks in "4 out of 6", and
-- recovering that from 0.667 needs a mark total that 54,304 published questions
-- do not have.
ALTER TABLE "bank_question_attempts"
    ADD COLUMN IF NOT EXISTS "awardedMarks" INTEGER;

ALTER TABLE "bank_question_attempts"
    ADD COLUMN IF NOT EXISTS "outOfMarks" INTEGER;
