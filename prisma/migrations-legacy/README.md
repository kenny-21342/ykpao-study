# Legacy migration history

These are the 30 migration directories that preceded the squashed baseline in
`prisma/migrations/00000000000000_init/`. They are kept for reference and are
**not** applied by `prisma migrate deploy` — Prisma only reads
`prisma/migrations/`.

## Why they were replaced

14 of them contained no `migration.sql` at all:

```
20260613090037_add_notebooks_textbooks   20260701090000_shared_note_attachments
20260622073601_add_past_paper_bank       20260701100000_notifications
20260622101044_add_past_paper_attempts   20260701110000_notification_actor_fk
20260622102134_add_mock_exams            20260701120000_school_resources
20260624120000_add_discussion_board      20260701130000_shared_note_subject
20260628210418_add_onboarding            20260701140000_user_bg_image
20260628210500_general_discussion
20260628210600_question_topics_bookmarks
```

The schema was evolved with `prisma db push` and the folders were left as
placeholders. `migrate deploy` against a fresh database therefore produced a
schema with no notebooks, mock exams, discussion board, or notifications —
that is, the production database could not be created at all.

## What was and wasn't carried over

The baseline is generated from `schema.prisma`, so it reproduces every model
exactly (verified: `prisma migrate diff --from-config-datasource --to-schema`
reports "No difference detected" after applying it to an empty database).

**Two categories did not come across automatically:**

1. **Raw SQL that Prisma cannot model.** `20260723160000_platform_rag_copilot`
   creates the `pg_trgm` extension, the `rag_chunks."searchVector"` generated
   tsvector column, and three GIN indexes. `lib/rag.ts` queries that column
   directly. `migrate diff` emits none of it, so it is appended by hand at the
   bottom of the baseline — **if you ever regenerate the baseline, re-append
   it**, or AI study search will fail with `column c.searchVector does not
   exist` on every query.

2. **Data backfills.** `20260723190000_personalized_study_context` repairs rows
   written by earlier versions (curriculum scopes, `courses.catalogManaged`,
   `rag_documents` subject codes, legacy single-subject goals). On a fresh
   database every one of them matches zero rows, so dropping them is safe —
   but they are the reason this directory is kept rather than deleted.

## Adopting the baseline on a database that already exists

The dev database has 26 of these recorded in `_prisma_migrations`, one of them
in a **failed** state, and its schema is behind `schema.prisma`. Running
`migrate deploy` there will refuse to start until that is cleared.

```bash
# 1. Clear the failed row (it blocks every subsequent deploy).
npx prisma migrate resolve --rolled-back 20260704130000_add_competition_questions

# 2. Declare the baseline already applied — do NOT let it run, the tables exist.
npx prisma migrate resolve --applied 00000000000000_init

# 3. Close the gap between the live schema and schema.prisma.
#    Review prisma/upgrade-existing-db.sql FIRST — it is machine-generated and
#    contains destructive statements (see the warning at the top of that file).
```

A **new** production database needs none of this: `prisma migrate deploy` on an
empty database produces the correct schema in one step.
