-- Let a generated paper draw from the crop-first bank.
--
-- Hand-written, like every migration here: the production database carries
-- deliberate drift that schema.prisma cannot express -- rag_chunks."searchVector"
-- is GENERATED ALWAYS ... STORED, and two indexes use gin_trgm_ops -- so
-- `prisma migrate dev` would offer to drop them.
--
-- Generation used to read `past_paper_questions`, which holds 21-43 rows for
-- the three science subjects and none at all for the other five a student can
-- enrol in. The real corpus is `bank_questions`. A foreign key can only point
-- at one table, so an item now carries one of two nullable references and
-- exactly one of them is set.
--
-- Widening only: "questionId" becomes nullable and a nullable column is added,
-- so every existing row stays valid and nothing is backfilled or dropped.

ALTER TABLE "mock_exam_items"
    ALTER COLUMN "questionId" DROP NOT NULL;

ALTER TABLE "mock_exam_items"
    ADD COLUMN "bankQuestionId" INTEGER;

ALTER TABLE "mock_exam_items"
    ADD CONSTRAINT "mock_exam_items_bankQuestionId_fkey"
    FOREIGN KEY ("bankQuestionId") REFERENCES "bank_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The invariant the application relies on, enforced where it cannot drift:
-- an item points at exactly one corpus, never both and never neither.
ALTER TABLE "mock_exam_items"
    ADD CONSTRAINT "mock_exam_items_one_question_source"
    CHECK (("questionId" IS NULL) <> ("bankQuestionId" IS NULL));

CREATE INDEX "mock_exam_items_bankQuestionId_idx"
    ON "mock_exam_items"("bankQuestionId");
