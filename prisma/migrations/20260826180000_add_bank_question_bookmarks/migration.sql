-- Star/bookmark for a crop-first bank question.
--
-- Hand-written, like every migration here: the production database carries
-- deliberate drift that schema.prisma cannot express -- rag_chunks."searchVector"
-- is GENERATED ALWAYS ... STORED, and two indexes use gin_trgm_ops -- so
-- `prisma migrate dev` would offer to drop them. Purely additive: one table,
-- one index, two foreign keys.
--
-- A third bookmark table because there are three question tables and a foreign
-- key can only point at one of them.

CREATE TABLE "bank_question_bookmarks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_question_bookmarks_pkey" PRIMARY KEY ("id")
);

-- One star per user per question; the upsert in the API relies on this.
CREATE UNIQUE INDEX "bank_question_bookmarks_userId_questionId_key"
    ON "bank_question_bookmarks"("userId", "questionId");

-- "My bookmarks" reads by user, so that lookup gets its own index.
CREATE INDEX "bank_question_bookmarks_userId_idx"
    ON "bank_question_bookmarks"("userId");

ALTER TABLE "bank_question_bookmarks"
    ADD CONSTRAINT "bank_question_bookmarks_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bank_question_bookmarks"
    ADD CONSTRAINT "bank_question_bookmarks_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "bank_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
