-- Editable drawings embedded inline in note pages (the "drawingBlock" TipTap
-- node), replacing "flatten to PNG and lose the strokes forever" with a row
-- the note references by id and can reopen for continued editing.
--
-- Hand-written, like every migration here: the production database carries
-- deliberate drift that schema.prisma cannot express -- rag_chunks."searchVector"
-- is GENERATED ALWAYS ... STORED, and two indexes use gin_trgm_ops -- so
-- `prisma migrate dev` would offer to drop them.

CREATE TABLE "page_drawings" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "strokesJson" JSONB NOT NULL,
    "thumbnailUrl" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "page_drawings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "page_drawings_pageId_idx"
    ON "page_drawings"("pageId");

ALTER TABLE "page_drawings"
    ADD CONSTRAINT "page_drawings_pageId_fkey"
    FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "page_drawings"
    ADD CONSTRAINT "page_drawings_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
