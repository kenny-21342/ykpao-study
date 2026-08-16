-- Add moderation columns + vote/flag tables for the discussion board.

ALTER TABLE "discussion_threads"
  ADD COLUMN IF NOT EXISTS "hidden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "upvotes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "downvotes" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "discussion_posts"
  ADD COLUMN IF NOT EXISTS "hidden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "upvotes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "downvotes" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "discussion_threads_hidden_idx" ON "discussion_threads"("hidden");
CREATE INDEX IF NOT EXISTS "discussion_posts_hidden_idx" ON "discussion_posts"("hidden");

CREATE TABLE "discussion_votes" (
    "id" TEXT NOT NULL,
    "threadId" TEXT,
    "postId" TEXT,
    "userId" TEXT NOT NULL,
    "direction" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "discussion_votes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "discussion_votes_userId_threadId_key" ON "discussion_votes"("userId", "threadId");
CREATE UNIQUE INDEX "discussion_votes_userId_postId_key" ON "discussion_votes"("userId", "postId");
CREATE INDEX "discussion_votes_threadId_idx" ON "discussion_votes"("threadId");
CREATE INDEX "discussion_votes_postId_idx" ON "discussion_votes"("postId");

CREATE TABLE "discussion_flags" (
    "id" TEXT NOT NULL,
    "threadId" TEXT,
    "postId" TEXT,
    "reporterId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "discussion_flags_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "discussion_flags_reporterId_threadId_key" ON "discussion_flags"("reporterId", "threadId");
CREATE UNIQUE INDEX "discussion_flags_reporterId_postId_key" ON "discussion_flags"("reporterId", "postId");
CREATE INDEX "discussion_flags_status_createdAt_idx" ON "discussion_flags"("status", "createdAt");
CREATE INDEX "discussion_flags_threadId_idx" ON "discussion_flags"("threadId");
CREATE INDEX "discussion_flags_postId_idx" ON "discussion_flags"("postId");

ALTER TABLE "discussion_votes"
  ADD CONSTRAINT "discussion_votes_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "discussion_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "discussion_votes_postId_fkey" FOREIGN KEY ("postId") REFERENCES "discussion_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "discussion_votes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "discussion_flags"
  ADD CONSTRAINT "discussion_flags_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "discussion_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "discussion_flags_postId_fkey" FOREIGN KEY ("postId") REFERENCES "discussion_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "discussion_flags_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "discussion_flags_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
