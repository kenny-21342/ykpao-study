-- NOTE (25 Sep): the five ADD COLUMN statements below were applied separately
-- by 20260925113000_bank_review_columns, because the RAG reindex needed them
-- and the DELETE in this file did not have sign-off. They are IF NOT EXISTS
-- here so this migration still applies cleanly afterwards; the DELETE and the
-- indexes are the only work left for it to do.

-- The corpus merge inserts review flags without source IDs. Repeating a merge
-- therefore inserted every flag again, even after an admin had reviewed it.
-- Keep a reviewed decision when duplicates already exist.
ALTER TABLE bank_review_flags ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT;
ALTER TABLE bank_review_flags ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
ALTER TABLE bank_review_flags ADD COLUMN IF NOT EXISTS "reviewNote" TEXT;
ALTER TABLE bank_questions ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT;
ALTER TABLE bank_questions ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY md5(
                   COALESCE("questionId"::text, '-') || E'\x1f' ||
                   COALESCE("paperId"::text, '-') || E'\x1f' ||
                   "issueType" || E'\x1f' || severity || E'\x1f' ||
                   message || E'\x1f' || COALESCE(evidence, '')
               )
               ORDER BY CASE status WHEN 'resolved' THEN 0 WHEN 'dismissed' THEN 1 ELSE 2 END, id
           ) AS position
    FROM bank_review_flags
)
DELETE FROM bank_review_flags
WHERE id IN (SELECT id FROM ranked WHERE position > 1);

-- A digest keeps the index small even when the QA evidence is long. The merge
-- already uses ON CONFLICT DO NOTHING, so the index also makes future imports
-- idempotent without changing the SQLite extraction schema.
CREATE UNIQUE INDEX IF NOT EXISTS "bank_review_flags_identity_idx" ON bank_review_flags ((
    md5(
        COALESCE("questionId"::text, '-') || E'\x1f' ||
        COALESCE("paperId"::text, '-') || E'\x1f' ||
        "issueType" || E'\x1f' || severity || E'\x1f' ||
        message || E'\x1f' || COALESCE(evidence, '')
    )
));

CREATE INDEX IF NOT EXISTS "bank_review_flags_paperId_status_severity_idx"
ON bank_review_flags ("paperId", status, severity);
