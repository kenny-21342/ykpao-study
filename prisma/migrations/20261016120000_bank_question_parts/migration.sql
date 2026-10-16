-- Per-sub-part topic and difficulty for multi-part bank questions.
--
-- Additive: a new table, nothing existing is altered. Until scripts/apply-parts.mjs
-- fills it the app behaves exactly as before, because every query that reads it
-- treats "no rows" as "single-part question".
--
-- `topic` is the topic name rather than a foreign key: the topic filters key on
-- name, and a bank_topics row is filed under only one level (SL/HL) of a subject
-- although it applies to both.
CREATE TABLE "bank_question_parts" (
    "id" SERIAL NOT NULL,
    "questionId" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "ordering" INTEGER NOT NULL,
    "marks" INTEGER,
    "topic" TEXT,
    "difficulty" INTEGER,
    "difficultySource" TEXT DEFAULT 'llm',
    "rationale" TEXT,
    "model" TEXT,
    "promptVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_question_parts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bank_question_parts_questionId_label_key" ON "bank_question_parts"("questionId", "label");
CREATE INDEX "bank_question_parts_topic_idx" ON "bank_question_parts"("topic");
CREATE INDEX "bank_question_parts_difficulty_idx" ON "bank_question_parts"("difficulty");

ALTER TABLE "bank_question_parts"
    ADD CONSTRAINT "bank_question_parts_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "bank_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
