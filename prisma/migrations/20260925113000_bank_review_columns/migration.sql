-- The additive half of 20260923150000_deduplicate_bank_review_flags.
--
-- That migration does two unrelated things: it adds review-tracking columns,
-- and it deletes 38,484 duplicate rows from bank_review_flags (52% of the
-- table) before adding a unique identity index. The columns are needed now --
-- `prisma.bankQuestion.findUnique()` fails with "The column
-- bank_questions.reviewedBy does not exist" and that blocks the RAG reindex
-- for 25,489 transcribed questions. The delete is not needed now, is not
-- reversible, and is held for a deliberate decision with a backup taken
-- first.
--
-- So the columns land here on their own. Every statement is IF NOT EXISTS, and
-- the matching statements in 20260923150000 were made IF NOT EXISTS too, so
-- whichever order they are applied in, neither fails on the other's work.
-- All five columns are nullable with no default, so this rewrites no rows.
ALTER TABLE bank_review_flags ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT;
ALTER TABLE bank_review_flags ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
ALTER TABLE bank_review_flags ADD COLUMN IF NOT EXISTS "reviewNote" TEXT;
ALTER TABLE bank_questions ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT;
ALTER TABLE bank_questions ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
