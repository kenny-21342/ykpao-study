-- Let a generated study task point at a crop-first bank question.
--
-- Hand-written, like every migration here: the production database carries
-- deliberate drift that schema.prisma cannot express -- rag_chunks."searchVector"
-- is GENERATED ALWAYS ... STORED, and two indexes use gin_trgm_ops -- so
-- `prisma migrate dev` would offer to drop them.
--
-- `generatePlan` picks its candidate questions from `past_paper_questions`,
-- because `study_tasks.questionId` is a foreign key to that table and there was
-- nowhere else to put an id. That is the last of the analytics paths still
-- blind to the corpus students actually practise in: a plan would send someone
-- to a transcribed question when 66,758 published bank questions, which render
-- as the page they were printed on, were available.
--
-- Widening only: one nullable column and one foreign key. No CHECK requiring
-- exactly one source -- a task can legitimately have neither, because
-- `taskType = 'mock-exam'` and hand-written tasks carry no question at all.

ALTER TABLE "study_tasks"
    ADD COLUMN "bankQuestionId" INTEGER;

-- The plan is read by user and due date; the id is only ever resolved for a
-- task already in hand, so no index on it.
--
-- SET NULL, matching the legacy relation: a planned task outlives the question
-- it pointed at rather than disappearing from the week.
ALTER TABLE "study_tasks"
    ADD CONSTRAINT "study_tasks_bankQuestionId_fkey"
    FOREIGN KEY ("bankQuestionId") REFERENCES "bank_questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
