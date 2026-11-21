-- Result of comparing a question's transcription with its scan: 'clean', 'minor' or
-- 'major'. NULL means not audited yet. The text view is the default only for 'clean'.
ALTER TABLE "bank_questions" ADD COLUMN "textAudit" TEXT;
ALTER TABLE "bank_questions" ADD COLUMN "textAuditNote" TEXT;
ALTER TABLE "bank_questions" ADD COLUMN "textAuditedAt" TIMESTAMP(3);
