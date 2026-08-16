-- Live awareness state for collaborative editing (cursor, typing, heartbeat).
CREATE TABLE "page_awareness" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cursorFrom" INTEGER,
    "cursorTo" INTEGER,
    "typing" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "page_awareness_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "page_awareness_pageId_userId_key"
    ON "page_awareness"("pageId", "userId");
CREATE INDEX "page_awareness_pageId_lastSeenAt_idx"
    ON "page_awareness"("pageId", "lastSeenAt");

ALTER TABLE "page_awareness"
    ADD CONSTRAINT "page_awareness_pageId_fkey"
    FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "page_awareness"
    ADD CONSTRAINT "page_awareness_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
