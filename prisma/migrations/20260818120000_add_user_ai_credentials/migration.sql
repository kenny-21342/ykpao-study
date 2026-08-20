-- Bring-your-own-key AI credentials.
--
-- HAND-WRITTEN, DELIBERATELY. This file was NOT produced by `prisma migrate
-- dev`, because that command diffs the whole schema and would offer to drop
-- the objects the baseline migration creates by hand at its bottom:
-- `rag_chunks."searchVector"` (a GENERATED ALWAYS … STORED tsvector) and the
-- three `gin_trgm_ops` indexes. `schema.prisma` cannot express any of them, so
-- Prisma reports them as drift. `lib/rag.ts` queries `searchVector` directly —
-- dropping it breaks AI study search entirely.
--
-- Everything below is purely additive: one CREATE TABLE and its indexes. It
-- touches no existing table, drops nothing, and is safe to apply to a live
-- database. The matching `aiCredential` field on the Prisma `User` model is a
-- relation field only and has no column of its own.

CREATE TABLE "user_ai_credentials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "encryptedApiKey" TEXT,
    "keyHint" TEXT,
    "baseUrl" TEXT,
    "textModel" TEXT,
    "visionModel" TEXT,
    "sharedKeyAccess" BOOLEAN NOT NULL DEFAULT false,
    "sharedKeyGrantedBy" TEXT,
    "sharedKeyGrantedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_ai_credentials_pkey" PRIMARY KEY ("id")
);

-- One row per user; the resolver looks the row up by userId on every AI call.
CREATE UNIQUE INDEX "user_ai_credentials_userId_key" ON "user_ai_credentials"("userId");

-- The admin console lists everyone holding a shared-key grant.
CREATE INDEX "user_ai_credentials_sharedKeyAccess_idx" ON "user_ai_credentials"("sharedKeyAccess");

ALTER TABLE "user_ai_credentials"
    ADD CONSTRAINT "user_ai_credentials_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
