-- Durable rate-limit counters, replacing the per-process in-memory limiter.
-- On serverless each invocation got a fresh Map, so login brute-force and
-- AI spend limits were effectively unenforced.
CREATE TABLE IF NOT EXISTS "rate_limits" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("key")
);

-- Supports the opportunistic sweep of expired windows.
CREATE INDEX IF NOT EXISTS "rate_limits_resetAt_idx" ON "rate_limits"("resetAt");

-- Foreign keys are not auto-indexed by Postgres. Each of these backs a query
-- that runs on a hot path:
--   users.syncToken   — every iPad sync request did a sequential scan
--   notes / notebooks / sections / shared_notes — per-user listing queries
CREATE INDEX IF NOT EXISTS "users_syncToken_idx" ON "users"("syncToken");
CREATE INDEX IF NOT EXISTS "notes_userId_updatedAt_idx" ON "notes"("userId", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS "notebooks_userId_idx" ON "notebooks"("userId");
CREATE INDEX IF NOT EXISTS "sections_notebookId_order_idx" ON "sections"("notebookId", "order");
CREATE INDEX IF NOT EXISTS "shared_notes_userId_idx" ON "shared_notes"("userId");
CREATE INDEX IF NOT EXISTS "shared_notes_visibility_createdAt_idx" ON "shared_notes"("visibility", "createdAt" DESC);
