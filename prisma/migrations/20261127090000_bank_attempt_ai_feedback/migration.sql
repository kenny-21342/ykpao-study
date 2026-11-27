-- What the AI marker said about an attempt (explanation, strengths, weaknesses,
-- model answer), so it is still there when the student reopens the question.
-- NULL for every attempt that was not AI-marked, and for AI attempts made
-- before this column existed.
ALTER TABLE "bank_question_attempts" ADD COLUMN "aiFeedback" JSONB;
