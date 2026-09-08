-- Feature 5: real CRDT collaborative editing (Yjs), flagged off by default.
-- Purely additive -- Page.content stays the authoritative HTML mirror,
-- updated exactly as it is today; these two tables only back the live
-- collaborative session and can be dropped at any time with zero data loss.
--
-- Hand-written, like every migration here: the production database carries
-- deliberate drift that schema.prisma cannot express -- rag_chunks."searchVector"
-- is GENERATED ALWAYS ... STORED, and two indexes use gin_trgm_ops -- so
-- `prisma migrate dev` would offer to drop them.

CREATE TABLE "page_yjs_updates" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_yjs_updates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "page_yjs_updates_pageId_createdAt_idx"
    ON "page_yjs_updates"("pageId", "createdAt");

ALTER TABLE "page_yjs_updates"
    ADD CONSTRAINT "page_yjs_updates_pageId_fkey"
    FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "page_yjs_snapshots" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "state" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "page_yjs_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "page_yjs_snapshots_pageId_key"
    ON "page_yjs_snapshots"("pageId");

ALTER TABLE "page_yjs_snapshots"
    ADD CONSTRAINT "page_yjs_snapshots_pageId_fkey"
    FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
