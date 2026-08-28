-- Let a spaced-review card point at a crop-first bank question.
--
-- Hand-written, like every migration here: the production database carries
-- deliberate drift that schema.prisma cannot express -- rag_chunks."searchVector"
-- is GENERATED ALWAYS ... STORED, and two indexes use gin_trgm_ops -- so
-- `prisma migrate dev` would offer to drop them.
--
-- The last of the four tables keyed to the legacy corpus. Without this, a
-- mistake on a bank question could not raise a card at all, and a mistake on a
-- legacy one usually had no mark scheme to put on the back -- the two together
-- are why the review queue was a third placeholder text and is now sparse.
--
-- Widening only: one nullable column, one partial-by-nature unique index
-- (Postgres treats NULLs as distinct, so hand-made cards with both ids null are
-- unconstrained by it), one foreign key. No CHECK requiring exactly one source:
-- unlike a mock-exam item, a card can legitimately have neither, because a
-- student can write one by hand from `prompt` and `answer` alone.

ALTER TABLE "review_items"
    ADD COLUMN "bankQuestionId" INTEGER;

-- One card per user per bank question: a repeated mistake refreshes the card
-- rather than stacking duplicates. This is what the upsert keys on.
CREATE UNIQUE INDEX "review_items_userId_bankQuestionId_key"
    ON "review_items"("userId", "bankQuestionId");

-- SET NULL, matching the legacy relation: a card outlives the question it came
-- from rather than vanishing mid-schedule.
ALTER TABLE "review_items"
    ADD CONSTRAINT "review_items_bankQuestionId_fkey"
    FOREIGN KEY ("bankQuestionId") REFERENCES "bank_questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
