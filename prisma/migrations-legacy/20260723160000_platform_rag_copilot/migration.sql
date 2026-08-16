CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE "learning_profiles"
  ADD COLUMN "board" TEXT,
  ADD COLUMN "qualification" TEXT,
  ADD COLUMN "level" TEXT,
  ADD COLUMN "subjectCode" TEXT,
  ADD COLUMN "currentLevel" TEXT,
  ADD COLUMN "recentResult" TEXT;

ALTER TABLE "study_tasks" ADD COLUMN "sourceRef" JSONB;
ALTER TABLE "past_paper_attempts" ADD COLUMN "gradingStatus" TEXT NOT NULL DEFAULT 'official';
ALTER TABLE "past_paper_attempts" ADD COLUMN "gradingSourceId" INTEGER;
ALTER TABLE "mock_exam_items" ADD COLUMN "gradingStatus" TEXT NOT NULL DEFAULT 'ungraded';
ALTER TABLE "mock_exam_items" ADD COLUMN "gradingSourceId" INTEGER;

ALTER TABLE "ai_messages"
  ADD COLUMN "intent" TEXT,
  ADD COLUMN "corpusCoverage" JSONB,
  ADD COLUMN "proposalId" TEXT;

CREATE TABLE "rag_documents" (
  "id" TEXT NOT NULL,
  "documentKey" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceRecordId" TEXT NOT NULL,
  "ownerId" TEXT,
  "title" TEXT NOT NULL,
  "route" TEXT,
  "board" TEXT,
  "qualification" TEXT,
  "level" TEXT,
  "subjectCode" TEXT,
  "topic" TEXT,
  "year" INTEGER,
  "session" TEXT,
  "paper" TEXT,
  "documentType" TEXT NOT NULL,
  "visibility" TEXT NOT NULL DEFAULT 'private',
  "accessUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "contentHash" TEXT NOT NULL,
  "extractionState" TEXT NOT NULL DEFAULT 'ready',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "extractedAt" TIMESTAMP(3),
  "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "rag_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rag_chunks" (
  "id" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("content", ''))) STORED,
  CONSTRAINT "rag_chunks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rag_corpus_manifests" (
  "id" TEXT NOT NULL,
  "board" TEXT NOT NULL DEFAULT '',
  "qualification" TEXT NOT NULL DEFAULT '',
  "level" TEXT NOT NULL DEFAULT '',
  "subjectCode" TEXT NOT NULL DEFAULT '',
  "year" INTEGER NOT NULL DEFAULT 0,
  "documentType" TEXT NOT NULL DEFAULT '',
  "extractionState" TEXT NOT NULL DEFAULT 'partial',
  "questionCount" INTEGER NOT NULL DEFAULT 0,
  "markSchemeCount" INTEGER NOT NULL DEFAULT 0,
  "resourceCount" INTEGER NOT NULL DEFAULT 0,
  "noteCount" INTEGER NOT NULL DEFAULT 0,
  "availableYears" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "availablePapers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "lastExtractionAt" TIMESTAMP(3),
  "lastIndexingAt" TIMESTAMP(3),
  "failures" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "rag_corpus_manifests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ai_action_proposals" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "conversationId" TEXT,
  "actionType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "idempotencyKey" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "confirmedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  "appliedResult" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ai_action_proposals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rag_documents_documentKey_key" ON "rag_documents"("documentKey");
CREATE INDEX "rag_documents_sourceType_sourceRecordId_idx" ON "rag_documents"("sourceType", "sourceRecordId");
CREATE INDEX "rag_documents_ownerId_visibility_idx" ON "rag_documents"("ownerId", "visibility");
CREATE INDEX "rag_documents_board_qualification_level_subjectCode_idx" ON "rag_documents"("board", "qualification", "level", "subjectCode");
CREATE INDEX "rag_documents_year_documentType_idx" ON "rag_documents"("year", "documentType");
CREATE INDEX "rag_documents_title_trgm_idx" ON "rag_documents" USING GIN ("title" gin_trgm_ops);

CREATE UNIQUE INDEX "rag_chunks_documentId_ordinal_key" ON "rag_chunks"("documentId", "ordinal");
CREATE INDEX "rag_chunks_documentId_idx" ON "rag_chunks"("documentId");
CREATE INDEX "rag_chunks_searchVector_idx" ON "rag_chunks" USING GIN ("searchVector");
CREATE INDEX "rag_chunks_content_trgm_idx" ON "rag_chunks" USING GIN ("content" gin_trgm_ops);

CREATE UNIQUE INDEX "rag_corpus_manifests_board_qualification_level_subjectCode_year_documentType_key"
  ON "rag_corpus_manifests"("board", "qualification", "level", "subjectCode", "year", "documentType");
CREATE INDEX "rag_corpus_manifests_board_qualification_level_subjectCode_idx"
  ON "rag_corpus_manifests"("board", "qualification", "level", "subjectCode");

CREATE UNIQUE INDEX "ai_action_proposals_idempotencyKey_key" ON "ai_action_proposals"("idempotencyKey");
CREATE INDEX "ai_action_proposals_ownerId_status_expiresAt_idx" ON "ai_action_proposals"("ownerId", "status", "expiresAt");
CREATE INDEX "ai_action_proposals_conversationId_idx" ON "ai_action_proposals"("conversationId");
CREATE UNIQUE INDEX "ai_messages_proposalId_key" ON "ai_messages"("proposalId");

ALTER TABLE "rag_documents" ADD CONSTRAINT "rag_documents_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "rag_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_action_proposals" ADD CONSTRAINT "ai_action_proposals_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_action_proposals" ADD CONSTRAINT "ai_action_proposals_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_proposalId_fkey"
  FOREIGN KEY ("proposalId") REFERENCES "ai_action_proposals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
