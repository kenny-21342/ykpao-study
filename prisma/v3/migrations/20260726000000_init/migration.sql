-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "V3DocumentStatus" AS ENUM ('MISSING', 'DOWNLOADING', 'INVALID', 'READY', 'EXTRACTING', 'REVIEW', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "V3DocumentType" AS ENUM ('QUESTION_PAPER', 'MARK_SCHEME', 'INSERT', 'SOURCE_BOOKLET', 'AUDIO', 'OTHER');

-- CreateEnum
CREATE TYPE "V3RunStatus" AS ENUM ('QUEUED', 'PREFLIGHT', 'EXTRACTING', 'VERIFYING', 'REVIEW', 'PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "V3PublicationStatus" AS ENUM ('DRAFT', 'REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED_LOCAL');

-- CreateEnum
CREATE TYPE "V3IssueSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "V3IssueStatus" AS ENUM ('OPEN', 'RESOLVED', 'REJECTED');

-- CreateTable
CREATE TABLE "v3_subjects" (
    "id" TEXT NOT NULL,
    "board" TEXT NOT NULL,
    "qualification" TEXT NOT NULL,
    "subjectCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "v3_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "v3_papers" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "qualification" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "session" TEXT NOT NULL,
    "paperNumber" TEXT NOT NULL,
    "paperType" TEXT NOT NULL,
    "component" TEXT NOT NULL DEFAULT '',
    "variant" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT '',
    "language" TEXT NOT NULL DEFAULT 'en',
    "totalMarks" INTEGER,
    "status" "V3PublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "v3_papers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "v3_source_documents" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "documentType" "V3DocumentType" NOT NULL,
    "resourceCode" TEXT NOT NULL DEFAULT '',
    "language" TEXT NOT NULL DEFAULT 'en',
    "status" "V3DocumentStatus" NOT NULL DEFAULT 'MISSING',
    "expected" BOOLEAN NOT NULL DEFAULT true,
    "inventoryBasis" TEXT NOT NULL DEFAULT 'authoritative',
    "sourceUrl" TEXT,
    "sourcePaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "localPath" TEXT,
    "partialPath" TEXT,
    "sha256" TEXT,
    "byteSize" BIGINT,
    "pageCount" INTEGER,
    "readable" BOOLEAN,
    "validation" JSONB NOT NULL DEFAULT '{}',
    "lastError" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "validatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "duplicateOfId" TEXT,

    CONSTRAINT "v3_source_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "v3_extraction_runs" (
    "id" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "status" "V3RunStatus" NOT NULL DEFAULT 'QUEUED',
    "extractorModel" TEXT NOT NULL,
    "verifierModel" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "rendererVersion" TEXT NOT NULL,
    "extractorProvider" TEXT NOT NULL DEFAULT '',
    "verifierProvider" TEXT NOT NULL DEFAULT '',
    "workPath" TEXT NOT NULL,
    "inputSha256" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "usage" JSONB NOT NULL DEFAULT '{}',
    "estimatedCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "stageReport" JSONB NOT NULL DEFAULT '{}',
    "failureStage" TEXT,
    "failureMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "v3_extraction_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "v3_questions" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "extractionRunId" TEXT NOT NULL,
    "rootNumber" TEXT NOT NULL,
    "numberSort" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "schemaVersion" TEXT NOT NULL DEFAULT 'QuestionDocumentV1',
    "contentHash" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "marks" INTEGER,
    "confidence" DOUBLE PRECISION NOT NULL,
    "publicationStatus" "V3PublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "v3_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "v3_mark_schemes" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "extractionRunId" TEXT NOT NULL,
    "questionId" TEXT,
    "rootNumber" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "schemaVersion" TEXT NOT NULL DEFAULT 'MarkSchemeDocumentV1',
    "contentHash" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "marks" INTEGER,
    "confidence" DOUBLE PRECISION NOT NULL,
    "publicationStatus" "V3PublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "v3_mark_schemes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "v3_assets" (
    "id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "byteSize" BIGINT NOT NULL,
    "sourceDocumentId" TEXT,
    "sourcePage" INTEGER,
    "cropX0" DOUBLE PRECISION,
    "cropY0" DOUBLE PRECISION,
    "cropX1" DOUBLE PRECISION,
    "cropY1" DOUBLE PRECISION,
    "role" TEXT NOT NULL,
    "caption" TEXT,
    "provenance" JSONB NOT NULL DEFAULT '{}',
    "qaOnly" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "v3_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "v3_question_assets" (
    "questionId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "ordering" INTEGER NOT NULL,
    "blockId" TEXT,

    CONSTRAINT "v3_question_assets_pkey" PRIMARY KEY ("questionId","assetId","role")
);

-- CreateTable
CREATE TABLE "v3_mark_scheme_assets" (
    "markSchemeId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "ordering" INTEGER NOT NULL,
    "blockId" TEXT,

    CONSTRAINT "v3_mark_scheme_assets_pkey" PRIMARY KEY ("markSchemeId","assetId","role")
);

-- CreateTable
CREATE TABLE "v3_paper_resources" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "sourceDocumentId" TEXT,
    "assetId" TEXT,
    "resourceType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "mimeType" TEXT,
    "relativePath" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "v3_paper_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "v3_topics" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "taxonomyVersion" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "canonicalLabel" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "parentId" TEXT,
    "effectiveFromYear" INTEGER NOT NULL,
    "effectiveToYear" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "v3_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "v3_question_topics" (
    "questionId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "taxonomyVersion" TEXT NOT NULL,
    "adminOverride" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "v3_question_topics_pkey" PRIMARY KEY ("questionId","topicId")
);

-- CreateTable
CREATE TABLE "v3_tags" (
    "id" TEXT NOT NULL,
    "canonicalLabel" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "v3_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "v3_question_tags" (
    "questionId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "taxonomyVersion" TEXT NOT NULL,
    "adminOverride" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "v3_question_tags_pkey" PRIMARY KEY ("questionId","tagId")
);

-- CreateTable
CREATE TABLE "v3_review_issues" (
    "id" TEXT NOT NULL,
    "extractionRunId" TEXT NOT NULL,
    "questionId" TEXT,
    "markSchemeId" TEXT,
    "sourceCropAssetId" TEXT,
    "issueType" TEXT NOT NULL,
    "severity" "V3IssueSeverity" NOT NULL,
    "status" "V3IssueStatus" NOT NULL DEFAULT 'OPEN',
    "fieldPath" TEXT,
    "message" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "correction" JSONB,
    "resolutionNote" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "v3_review_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "v3_subjects_name_idx" ON "v3_subjects"("name");

-- CreateIndex
CREATE UNIQUE INDEX "v3_subjects_board_qualification_subjectCode_key" ON "v3_subjects"("board", "qualification", "subjectCode");

-- CreateIndex
CREATE INDEX "v3_papers_subjectId_year_session_idx" ON "v3_papers"("subjectId", "year", "session");

-- CreateIndex
CREATE INDEX "v3_papers_status_idx" ON "v3_papers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "v3_papers_subjectId_qualification_level_year_session_paperN_key" ON "v3_papers"("subjectId", "qualification", "level", "year", "session", "paperNumber", "paperType", "component", "variant", "timezone", "language");

-- CreateIndex
CREATE INDEX "v3_source_documents_status_documentType_idx" ON "v3_source_documents"("status", "documentType");

-- CreateIndex
CREATE INDEX "v3_source_documents_sha256_idx" ON "v3_source_documents"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "v3_source_documents_paperId_documentType_resourceCode_langu_key" ON "v3_source_documents"("paperId", "documentType", "resourceCode", "language");

-- CreateIndex
CREATE INDEX "v3_extraction_runs_sourceDocumentId_status_idx" ON "v3_extraction_runs"("sourceDocumentId", "status");

-- CreateIndex
CREATE INDEX "v3_extraction_runs_createdAt_idx" ON "v3_extraction_runs"("createdAt");

-- CreateIndex
CREATE INDEX "v3_questions_paperId_numberSort_idx" ON "v3_questions"("paperId", "numberSort");

-- CreateIndex
CREATE INDEX "v3_questions_publicationStatus_confidence_idx" ON "v3_questions"("publicationStatus", "confidence");

-- CreateIndex
CREATE INDEX "v3_questions_contentHash_idx" ON "v3_questions"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "v3_questions_paperId_rootNumber_schemaVersion_key" ON "v3_questions"("paperId", "rootNumber", "schemaVersion");

-- CreateIndex
CREATE UNIQUE INDEX "v3_mark_schemes_questionId_key" ON "v3_mark_schemes"("questionId");

-- CreateIndex
CREATE INDEX "v3_mark_schemes_paperId_rootNumber_idx" ON "v3_mark_schemes"("paperId", "rootNumber");

-- CreateIndex
CREATE INDEX "v3_mark_schemes_publicationStatus_confidence_idx" ON "v3_mark_schemes"("publicationStatus", "confidence");

-- CreateIndex
CREATE UNIQUE INDEX "v3_mark_schemes_paperId_rootNumber_schemaVersion_key" ON "v3_mark_schemes"("paperId", "rootNumber", "schemaVersion");

-- CreateIndex
CREATE UNIQUE INDEX "v3_assets_sha256_key" ON "v3_assets"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "v3_assets_relativePath_key" ON "v3_assets"("relativePath");

-- CreateIndex
CREATE INDEX "v3_assets_sourceDocumentId_sourcePage_idx" ON "v3_assets"("sourceDocumentId", "sourcePage");

-- CreateIndex
CREATE INDEX "v3_question_assets_questionId_ordering_idx" ON "v3_question_assets"("questionId", "ordering");

-- CreateIndex
CREATE INDEX "v3_mark_scheme_assets_markSchemeId_ordering_idx" ON "v3_mark_scheme_assets"("markSchemeId", "ordering");

-- CreateIndex
CREATE INDEX "v3_paper_resources_paperId_resourceType_idx" ON "v3_paper_resources"("paperId", "resourceType");

-- CreateIndex
CREATE UNIQUE INDEX "v3_paper_resources_paperId_resourceType_label_key" ON "v3_paper_resources"("paperId", "resourceType", "label");

-- CreateIndex
CREATE INDEX "v3_topics_subjectId_effectiveFromYear_idx" ON "v3_topics"("subjectId", "effectiveFromYear");

-- CreateIndex
CREATE UNIQUE INDEX "v3_topics_subjectId_taxonomyVersion_code_key" ON "v3_topics"("subjectId", "taxonomyVersion", "code");

-- CreateIndex
CREATE INDEX "v3_question_topics_topicId_confidence_idx" ON "v3_question_topics"("topicId", "confidence");

-- CreateIndex
CREATE UNIQUE INDEX "v3_tags_canonicalLabel_key" ON "v3_tags"("canonicalLabel");

-- CreateIndex
CREATE INDEX "v3_question_tags_tagId_confidence_idx" ON "v3_question_tags"("tagId", "confidence");

-- CreateIndex
CREATE INDEX "v3_review_issues_status_severity_issueType_idx" ON "v3_review_issues"("status", "severity", "issueType");

-- CreateIndex
CREATE INDEX "v3_review_issues_extractionRunId_status_idx" ON "v3_review_issues"("extractionRunId", "status");

-- CreateIndex
CREATE INDEX "v3_review_issues_questionId_idx" ON "v3_review_issues"("questionId");

-- AddForeignKey
ALTER TABLE "v3_papers" ADD CONSTRAINT "v3_papers_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "v3_subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_source_documents" ADD CONSTRAINT "v3_source_documents_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "v3_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_source_documents" ADD CONSTRAINT "v3_source_documents_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "v3_source_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_extraction_runs" ADD CONSTRAINT "v3_extraction_runs_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "v3_source_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_questions" ADD CONSTRAINT "v3_questions_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "v3_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_questions" ADD CONSTRAINT "v3_questions_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "v3_source_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_questions" ADD CONSTRAINT "v3_questions_extractionRunId_fkey" FOREIGN KEY ("extractionRunId") REFERENCES "v3_extraction_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_mark_schemes" ADD CONSTRAINT "v3_mark_schemes_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "v3_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_mark_schemes" ADD CONSTRAINT "v3_mark_schemes_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "v3_source_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_mark_schemes" ADD CONSTRAINT "v3_mark_schemes_extractionRunId_fkey" FOREIGN KEY ("extractionRunId") REFERENCES "v3_extraction_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_mark_schemes" ADD CONSTRAINT "v3_mark_schemes_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "v3_questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_assets" ADD CONSTRAINT "v3_assets_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "v3_source_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_question_assets" ADD CONSTRAINT "v3_question_assets_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "v3_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_question_assets" ADD CONSTRAINT "v3_question_assets_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "v3_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_mark_scheme_assets" ADD CONSTRAINT "v3_mark_scheme_assets_markSchemeId_fkey" FOREIGN KEY ("markSchemeId") REFERENCES "v3_mark_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_mark_scheme_assets" ADD CONSTRAINT "v3_mark_scheme_assets_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "v3_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_paper_resources" ADD CONSTRAINT "v3_paper_resources_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "v3_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_paper_resources" ADD CONSTRAINT "v3_paper_resources_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "v3_source_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_paper_resources" ADD CONSTRAINT "v3_paper_resources_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "v3_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_topics" ADD CONSTRAINT "v3_topics_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "v3_subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_topics" ADD CONSTRAINT "v3_topics_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "v3_topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_question_topics" ADD CONSTRAINT "v3_question_topics_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "v3_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_question_topics" ADD CONSTRAINT "v3_question_topics_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "v3_topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_question_tags" ADD CONSTRAINT "v3_question_tags_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "v3_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_question_tags" ADD CONSTRAINT "v3_question_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "v3_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_review_issues" ADD CONSTRAINT "v3_review_issues_extractionRunId_fkey" FOREIGN KEY ("extractionRunId") REFERENCES "v3_extraction_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_review_issues" ADD CONSTRAINT "v3_review_issues_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "v3_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_review_issues" ADD CONSTRAINT "v3_review_issues_markSchemeId_fkey" FOREIGN KEY ("markSchemeId") REFERENCES "v3_mark_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v3_review_issues" ADD CONSTRAINT "v3_review_issues_sourceCropAssetId_fkey" FOREIGN KEY ("sourceCropAssetId") REFERENCES "v3_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
