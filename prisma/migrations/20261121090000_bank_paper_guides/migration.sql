-- Paper-level marking guidance: the pages of a paper's own mark-scheme PDF,
-- shown on questions that have no per-question mark scheme.
--
-- Additive: a new table, nothing existing is altered. Until
-- scripts/apply-paper-guides.mjs fills it the app behaves exactly as before,
-- because every read treats "no rows" as "no guidance".
CREATE TABLE "bank_paper_guides" (
    "paperId" INTEGER NOT NULL,
    "ordering" INTEGER NOT NULL,
    "assetId" INTEGER NOT NULL,
    "page" INTEGER NOT NULL,

    CONSTRAINT "bank_paper_guides_pkey" PRIMARY KEY ("paperId", "ordering")
);

CREATE INDEX "bank_paper_guides_assetId_idx" ON "bank_paper_guides"("assetId");

ALTER TABLE "bank_paper_guides"
    ADD CONSTRAINT "bank_paper_guides_paperId_fkey"
    FOREIGN KEY ("paperId") REFERENCES "bank_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bank_paper_guides"
    ADD CONSTRAINT "bank_paper_guides_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "bank_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
