-- Trigram indexes for the two `ILIKE '%term%'` scans in /api/search.
--
-- Global search matches bank question and mark-scheme text with a
-- leading-wildcard ILIKE, which no B-tree can serve. Measured on production
-- 27 Sep: 1.04s and 1.08s respectively, both sequential scans of the whole
-- table. `bodyMd` holds 30 MB of text across 65,572 published questions and
-- `answerMd` another 30 MB across 52,004 mark schemes, so this is the shape
-- `pg_trgm` exists for. Expect roughly 30 MB per index, judging by
-- `rag_chunks_content_trgm_idx` at 87 MB over ~100 MB of chunk text.
--
-- These only become reachable together with the query rewrite in the same
-- commit. Before it, the ILIKE sat in an `OR` alongside two clauses reading
-- the joined `bank_subjects` row, so Postgres could only evaluate the whole
-- predicate after the join and no index on either table applied. Splitting
-- the branches into separate queries is what makes the text predicate
-- single-table and therefore indexable; the index without that rewrite would
-- have been dead weight.
--
-- Hand-written because `schema.prisma` cannot express an operator class, the
-- same reason every other `gin_trgm_ops` index here lives in SQL. `pg_trgm`
-- is already installed -- `00000000000000_init` creates it for the two
-- rag_* indexes.
--
-- Not CONCURRENTLY: `migrate deploy` may run a migration inside a
-- transaction, where CONCURRENTLY is rejected outright, and a failed
-- migration leaves a row behind in _prisma_migrations to clean up by hand.
-- A plain build takes an ACCESS EXCLUSIVE lock on each table for its
-- duration, which blocks /bank while it runs. That is a deliberate trade at
-- this size and this traffic; both statements are IF NOT EXISTS, so a re-run
-- is a no-op, and either index is reversible with a DROP.
CREATE INDEX IF NOT EXISTS "bank_questions_bodyMd_trgm_idx"
  ON "bank_questions" USING GIN ("bodyMd" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "bank_mark_schemes_answerMd_trgm_idx"
  ON "bank_mark_schemes" USING GIN ("answerMd" gin_trgm_ops);
