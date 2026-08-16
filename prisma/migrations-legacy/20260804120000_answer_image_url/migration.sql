-- Store the original photo/screenshot of the student's handwritten answer so
-- they can review their working later. Optional on both attempt shapes.
ALTER TABLE "past_paper_attempts" ADD COLUMN "answerImageUrl" TEXT;
ALTER TABLE "mock_exam_items" ADD COLUMN "answerImageUrl" TEXT;
