-- AlterTable
ALTER TABLE "pages"
ADD COLUMN "icon" TEXT NOT NULL DEFAULT '',
ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "favorite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "linkedQuestionIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN "splitQuestionId" INTEGER,
ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "page_snapshots" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "createdById" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'autosave',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "page_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "page_collaborators" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'editor',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "page_collaborators_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "page_comments" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "anchor" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "page_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "page_presences" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "page_presences_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "pages_sectionId_order_idx" ON "pages"("sectionId", "order");
CREATE INDEX "pages_favorite_idx" ON "pages"("favorite");
CREATE INDEX "pages_archived_idx" ON "pages"("archived");
CREATE INDEX "page_snapshots_pageId_createdAt_idx" ON "page_snapshots"("pageId", "createdAt");
CREATE UNIQUE INDEX "page_collaborators_pageId_userId_key" ON "page_collaborators"("pageId", "userId");
CREATE INDEX "page_collaborators_userId_idx" ON "page_collaborators"("userId");
CREATE INDEX "page_comments_pageId_resolved_createdAt_idx" ON "page_comments"("pageId", "resolved", "createdAt");
CREATE UNIQUE INDEX "page_presences_pageId_userId_key" ON "page_presences"("pageId", "userId");
CREATE INDEX "page_presences_pageId_lastSeenAt_idx" ON "page_presences"("pageId", "lastSeenAt");

ALTER TABLE "page_snapshots" ADD CONSTRAINT "page_snapshots_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "page_snapshots" ADD CONSTRAINT "page_snapshots_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "page_collaborators" ADD CONSTRAINT "page_collaborators_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "page_collaborators" ADD CONSTRAINT "page_collaborators_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "page_presences" ADD CONSTRAINT "page_presences_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "page_presences" ADD CONSTRAINT "page_presences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
