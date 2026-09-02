-- Command-term ("skill") tagging for the crop-first question bank.
--
-- Apply this file by hand, the way the other migrations in this folder were
-- applied. Do NOT run `prisma migrate deploy` / `migrate dev` / `db push`:
-- production carries deliberate drift that schema.prisma cannot express
-- (rag_chunks."searchVector" is GENERATED ALWAYS ... STORED, and two indexes
-- use gin_trgm_ops), and the migration history in _prisma_migrations does not
-- match this folder, so `deploy` would try to create tables that already exist.
--
-- Every statement is idempotent, so re-running is safe.
--
-- Why a new table rather than a reserved slug namespace inside bank_tags:
-- tags are the open vocabulary a student types into search; skills are the
-- closed list a mark scheme rewards against. Keeping them apart keeps search
-- results clean and lets the per-command-term accuracy panel trust its input.

CREATE TABLE IF NOT EXISTS "bank_skills" (
    "id"    SERIAL NOT NULL,
    "slug"  TEXT   NOT NULL,
    "label" TEXT   NOT NULL,

    CONSTRAINT "bank_skills_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "bank_skills_slug_key" ON "bank_skills"("slug");

CREATE TABLE IF NOT EXISTS "bank_question_skills" (
    "questionId" INTEGER      NOT NULL,
    "skillId"    INTEGER      NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_question_skills_pkey" PRIMARY KEY ("questionId", "skillId")
);

CREATE INDEX IF NOT EXISTS "bank_question_skills_skillId_idx" ON "bank_question_skills"("skillId");

DO $$
BEGIN
    ALTER TABLE "bank_question_skills"
        ADD CONSTRAINT "bank_question_skills_questionId_fkey"
        FOREIGN KEY ("questionId") REFERENCES "bank_questions"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "bank_question_skills"
        ADD CONSTRAINT "bank_question_skills_skillId_fkey"
        FOREIGN KEY ("skillId") REFERENCES "bank_skills"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
