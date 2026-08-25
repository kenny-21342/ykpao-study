-- The rendered crop, in reading order.
--
-- HAND-WRITTEN, DELIBERATELY. This file was NOT produced by `prisma migrate
-- dev`, because that command diffs the whole schema and would offer to drop
-- the objects the baseline migration creates by hand at its bottom:
-- `rag_chunks."searchVector"` (a GENERATED ALWAYS … STORED tsvector) and the
-- `gin_trgm_ops` indexes. `schema.prisma` cannot express any of them, so
-- Prisma reports them as drift. `lib/rag.ts` queries `searchVector` directly —
-- dropping it breaks AI study search entirely.
--
-- Everything below is purely additive: two CREATE TABLEs and their indexes. It
-- touches no existing table, drops nothing, and is safe to apply to a live
-- database.
--
-- Why these tables exist: `bank_questions."screenshotId"` holds a single asset,
-- which was all a transcription-first bank needed. Measured over 490 questions,
-- 89% render as two or more strips and one needs 29, so showing a student that
-- column alone gives them the top fragment of nine questions in ten. The
-- column stays, pointing at strip 0, for readers that only want a thumbnail.

CREATE TABLE "bank_question_strips" (
    "questionId" INTEGER NOT NULL,
    "assetId" INTEGER NOT NULL,
    "ordering" INTEGER NOT NULL,
    "page" INTEGER NOT NULL,

    CONSTRAINT "bank_question_strips_pkey" PRIMARY KEY ("questionId", "ordering")
);

CREATE TABLE "bank_mark_scheme_strips" (
    "markSchemeId" INTEGER NOT NULL,
    "assetId" INTEGER NOT NULL,
    "ordering" INTEGER NOT NULL,
    "page" INTEGER NOT NULL,

    CONSTRAINT "bank_mark_scheme_strips_pkey" PRIMARY KEY ("markSchemeId", "ordering")
);

CREATE INDEX "bank_question_strips_assetId_idx" ON "bank_question_strips"("assetId");
CREATE INDEX "bank_mark_scheme_strips_assetId_idx" ON "bank_mark_scheme_strips"("assetId");

ALTER TABLE "bank_question_strips"
    ADD CONSTRAINT "bank_question_strips_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "bank_questions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bank_question_strips"
    ADD CONSTRAINT "bank_question_strips_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "bank_assets"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bank_mark_scheme_strips"
    ADD CONSTRAINT "bank_mark_scheme_strips_markSchemeId_fkey"
    FOREIGN KEY ("markSchemeId") REFERENCES "bank_mark_schemes"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bank_mark_scheme_strips"
    ADD CONSTRAINT "bank_mark_scheme_strips_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "bank_assets"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
