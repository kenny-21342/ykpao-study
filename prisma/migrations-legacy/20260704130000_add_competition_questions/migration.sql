
-- CreateTable
CREATE TABLE "competition_questions" (
    "id" SERIAL NOT NULL,
    "competition" TEXT NOT NULL DEFAULT 'STEP',
    "code" TEXT NOT NULL,
    "yearLabel" TEXT NOT NULL,
    "paper" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "imageUrl" TEXT,
    "pdfUrl" TEXT,
    "texUrl" TEXT,
    "sourceSite" TEXT NOT NULL DEFAULT 'stepdatabase.maths.org',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competition_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "competition_questions_competition_idx" ON "competition_questions"("competition");

-- CreateIndex
CREATE INDEX "competition_questions_yearLabel_idx" ON "competition_questions"("yearLabel");

-- CreateIndex
CREATE INDEX "competition_questions_paper_idx" ON "competition_questions"("paper");

-- CreateIndex
CREATE UNIQUE INDEX "competition_questions_competition_code_key" ON "competition_questions"("competition", "code");

