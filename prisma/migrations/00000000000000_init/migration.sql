-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "bgImage" TEXT,
    "password" TEXT,
    "role" TEXT NOT NULL DEFAULT 'student',
    "banned" BOOLEAN NOT NULL DEFAULT false,
    "bannedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "onboardedAt" TIMESTAMP(3),
    "unlocks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "syncToken" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT,
    "title" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'explain',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sources" JSONB,
    "actionType" TEXT,
    "actionData" JSONB,
    "intent" TEXT,
    "corpusCoverage" JSONB,
    "proposalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "model" TEXT NOT NULL DEFAULT 'deepseek-chat',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "courses" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "description" TEXT,
    "catalogManaged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_courses" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "targetGrade" TEXT,
    "examDate" TIMESTAMP(3),
    "currentLevel" TEXT,
    "recentResult" TEXT,
    "personalizationEnabled" BOOLEAN NOT NULL DEFAULT true,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_curriculum_scopes" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "board" TEXT NOT NULL,
    "qualification" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "subjectCode" TEXT NOT NULL,

    CONSTRAINT "course_curriculum_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "questionType" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "year" INTEGER,
    "paperId" TEXT,
    "pageNumber" INTEGER,
    "marks" INTEGER,
    "topics" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subjects" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "board" TEXT NOT NULL DEFAULT 'CAIE',
    "qualification" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "past_papers" (
    "id" SERIAL NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "session" TEXT NOT NULL,
    "paperNumber" INTEGER NOT NULL,
    "variant" INTEGER NOT NULL DEFAULT 0,
    "docType" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "filepath" TEXT NOT NULL,
    "fileHash" TEXT,
    "totalMarks" INTEGER NOT NULL DEFAULT 0,
    "insertText" TEXT NOT NULL DEFAULT '',
    "processedAt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL DEFAULT '',
    "paperCode" TEXT NOT NULL DEFAULT '',
    "pageCount" INTEGER,
    "sizeBytes" INTEGER,

    CONSTRAINT "past_papers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "past_paper_questions" (
    "id" INTEGER NOT NULL,
    "paperId" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "part" TEXT NOT NULL DEFAULT '',
    "subPart" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL,
    "latex" TEXT NOT NULL DEFAULT '',
    "marks" INTEGER NOT NULL DEFAULT 0,
    "hasDiagram" INTEGER NOT NULL DEFAULT 0,
    "diagramRef" TEXT NOT NULL DEFAULT '',
    "ordering" INTEGER NOT NULL DEFAULT 0,
    "docType" TEXT NOT NULL DEFAULT 'qp',
    "topic" TEXT NOT NULL DEFAULT 'General',

    CONSTRAINT "past_paper_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "examDate" TIMESTAMP(3),
    "weeklyStudyMinutes" INTEGER NOT NULL DEFAULT 300,
    "targetGrade" TEXT NOT NULL DEFAULT 'A',
    "board" TEXT,
    "qualification" TEXT,
    "level" TEXT,
    "subjectCode" TEXT,
    "currentLevel" TEXT,
    "recentResult" TEXT,
    "availability" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_tasks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" INTEGER,
    "title" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "taskType" TEXT NOT NULL DEFAULT 'practice',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "completedAt" TIMESTAMP(3),
    "sourceRef" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "study_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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
    "accessUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contentHash" TEXT NOT NULL,
    "extractionState" TEXT NOT NULL DEFAULT 'ready',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "extractedAt" TIMESTAMP(3),
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rag_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rag_chunks" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rag_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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
    "availableYears" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "availablePapers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastExtractionAt" TIMESTAMP(3),
    "lastIndexingAt" TIMESTAMP(3),
    "failures" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rag_corpus_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "review_items" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" INTEGER,
    "prompt" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "nextReviewAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "intervalDays" INTEGER NOT NULL DEFAULT 0,
    "easeFactor" DOUBLE PRECISION NOT NULL DEFAULT 2.5,
    "repetitions" INTEGER NOT NULL DEFAULT 0,
    "lapses" INTEGER NOT NULL DEFAULT 0,
    "lastReviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "review_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_images" (
    "id" SERIAL NOT NULL,
    "questionId" INTEGER NOT NULL,
    "imagePath" TEXT NOT NULL,
    "pageNumber" INTEGER,
    "bboxX0" DOUBLE PRECISION,
    "bboxY0" DOUBLE PRECISION,
    "bboxX1" DOUBLE PRECISION,
    "bboxY1" DOUBLE PRECISION,

    CONSTRAINT "question_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "past_paper_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" INTEGER NOT NULL,
    "answer" TEXT NOT NULL,
    "score" DOUBLE PRECISION,
    "maxScore" INTEGER,
    "isCorrect" BOOLEAN,
    "strengths" TEXT[],
    "weaknesses" TEXT[],
    "explanation" TEXT,
    "modelAnswer" TEXT,
    "gradingStatus" TEXT NOT NULL DEFAULT 'official',
    "gradingSourceId" INTEGER,
    "timeSpent" INTEGER,
    "answerImageUrl" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "past_paper_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_exams" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "subjectCode" TEXT,
    "durationMinutes" INTEGER NOT NULL,
    "totalMarks" INTEGER NOT NULL,
    "topics" TEXT[],
    "difficulty" TEXT NOT NULL DEFAULT 'mixed',
    "status" TEXT NOT NULL DEFAULT 'generated',
    "startedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "score" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mock_exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mock_exam_items" (
    "id" TEXT NOT NULL,
    "mockExamId" TEXT NOT NULL,
    "questionId" INTEGER NOT NULL,
    "sectionTitle" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "answer" TEXT,
    "score" DOUBLE PRECISION,
    "isCorrect" BOOLEAN,
    "explanation" TEXT,
    "modelAnswer" TEXT,
    "strengths" TEXT[],
    "weaknesses" TEXT[],
    "gradingStatus" TEXT NOT NULL DEFAULT 'ungraded',
    "gradingSourceId" INTEGER,
    "answerImageUrl" TEXT,
    "attemptedAt" TIMESTAMP(3),

    CONSTRAINT "mock_exam_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "isCorrect" BOOLEAN,
    "score" DOUBLE PRECISION,
    "feedback" TEXT,
    "timeSpent" INTEGER,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "question_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tags" TEXT[],
    "folderId" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "linkedQuestions" TEXT[],
    "linkedTextbookPages" TEXT[],

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_folders" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared_notes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "subject" TEXT,
    "courseCode" TEXT,
    "tags" TEXT[],
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "views" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shared_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_comments" (
    "id" TEXT NOT NULL,
    "sharedNoteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_ratings" (
    "id" TEXT NOT NULL,
    "sharedNoteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookmarks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "past_paper_bookmarks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "past_paper_bookmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "study_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endTime" TIMESTAMP(3),
    "duration" INTEGER,
    "subject" TEXT,
    "notes" TEXT,

    CONSTRAINT "study_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follows" (
    "id" TEXT NOT NULL,
    "followerId" TEXT NOT NULL,
    "followingId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notebooks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT DEFAULT '#3b82f6',
    "icon" TEXT DEFAULT '📓',
    "courseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notebooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" TEXT NOT NULL,
    "notebookId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "icon" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "linkedQuestionIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "splitQuestionId" INTEGER,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_snapshots" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "createdById" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'autosave',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_collaborators" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'editor',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_collaborators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_comments" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "anchor" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "page_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_presences" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_presences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_awareness" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cursorFrom" INTEGER,
    "cursorTo" INTEGER,
    "typing" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "page_awareness_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discussion_threads" (
    "id" TEXT NOT NULL,
    "subjectId" INTEGER,
    "category" TEXT,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "views" INTEGER NOT NULL DEFAULT 0,
    "upvotes" INTEGER NOT NULL DEFAULT 0,
    "downvotes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discussion_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discussion_posts" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "parentId" TEXT,
    "content" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "upvotes" INTEGER NOT NULL DEFAULT 0,
    "downvotes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discussion_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discussion_votes" (
    "id" TEXT NOT NULL,
    "threadId" TEXT,
    "postId" TEXT,
    "userId" TEXT NOT NULL,
    "direction" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discussion_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actorId" TEXT,
    "type" TEXT NOT NULL,
    "entityId" TEXT,
    "entityUrl" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "school_resources" (
    "id" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "subject" TEXT,
    "category" TEXT,
    "fileUrl" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL DEFAULT 0,
    "mimeType" TEXT NOT NULL DEFAULT '',
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "audience" TEXT NOT NULL DEFAULT 'all',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_collaborators" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'editor',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_collaborators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_challenge_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionId" INTEGER NOT NULL,
    "dateKey" TEXT NOT NULL,
    "answer" TEXT NOT NULL DEFAULT '',
    "score" DOUBLE PRECISION,
    "isCorrect" BOOLEAN,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_challenge_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_questions" (
    "id" SERIAL NOT NULL,
    "competition" TEXT NOT NULL DEFAULT 'STEP',
    "code" TEXT NOT NULL,
    "yearLabel" TEXT NOT NULL,
    "paper" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "imageUrl" TEXT,
    "pdfUrl" TEXT,
    "texUrl" TEXT,
    "sourceSite" TEXT NOT NULL DEFAULT 'stepdatabase.maths.org',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competition_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cloud_documents" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Untitled',
    "format" TEXT NOT NULL DEFAULT 'hybrid',
    "body" TEXT NOT NULL DEFAULT '',
    "blocks" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cloud_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_subjects" (
    "id" SERIAL NOT NULL,
    "board" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "level" TEXT,

    CONSTRAINT "bank_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_papers" (
    "id" SERIAL NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "board" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "session" TEXT NOT NULL,
    "paperNumber" INTEGER NOT NULL,
    "variant" INTEGER NOT NULL DEFAULT 0,
    "timezone" TEXT,
    "docType" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "spanStrategy" TEXT,
    "usedOcr" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_papers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_questions" (
    "id" SERIAL NOT NULL,
    "paperId" INTEGER NOT NULL,
    "rootNumber" INTEGER NOT NULL,
    "bodyMd" TEXT NOT NULL,
    "parts" TEXT NOT NULL DEFAULT '[]',
    "totalMarks" INTEGER,
    "screenshotId" INTEGER,
    "pageStart" INTEGER,
    "pageEnd" INTEGER,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'needs_review',
    "difficulty" INTEGER,
    "difficultySource" TEXT,
    "difficultyRationale" TEXT,
    "runId" TEXT,
    "model" TEXT,
    "promptVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_mark_schemes" (
    "id" SERIAL NOT NULL,
    "questionId" INTEGER NOT NULL,
    "paperId" INTEGER NOT NULL,
    "rootNumber" INTEGER NOT NULL,
    "answerMd" TEXT NOT NULL,
    "markingPoints" TEXT NOT NULL DEFAULT '[]',
    "totalMarks" INTEGER,
    "answerLetter" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'needs_review',
    "runId" TEXT,
    "model" TEXT,
    "promptVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_mark_schemes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_assets" (
    "id" SERIAL NOT NULL,
    "sha256" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "byteSize" INTEGER,
    "sourcePage" INTEGER,
    "bbox" TEXT,
    "sourceDpi" INTEGER NOT NULL DEFAULT 200,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_question_assets" (
    "questionId" INTEGER NOT NULL,
    "assetId" INTEGER NOT NULL,
    "placeholder" TEXT NOT NULL,
    "ordering" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_question_assets_pkey" PRIMARY KEY ("questionId","placeholder")
);

-- CreateTable
CREATE TABLE "bank_mark_scheme_assets" (
    "markSchemeId" INTEGER NOT NULL,
    "assetId" INTEGER NOT NULL,
    "placeholder" TEXT NOT NULL,
    "ordering" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_mark_scheme_assets_pkey" PRIMARY KEY ("markSchemeId","placeholder")
);

-- CreateTable
CREATE TABLE "bank_topics" (
    "id" SERIAL NOT NULL,
    "subjectId" INTEGER NOT NULL,
    "code" TEXT,
    "name" TEXT NOT NULL,

    CONSTRAINT "bank_topics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_question_topics" (
    "questionId" INTEGER NOT NULL,
    "topicId" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_question_topics_pkey" PRIMARY KEY ("questionId","topicId")
);

-- CreateTable
CREATE TABLE "bank_tags" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "bank_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_question_tags" (
    "questionId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_question_tags_pkey" PRIMARY KEY ("questionId","tagId")
);

-- CreateTable
CREATE TABLE "bank_review_flags" (
    "id" SERIAL NOT NULL,
    "questionId" INTEGER,
    "paperId" INTEGER,
    "issueType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "evidence" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_review_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_run_ledger" (
    "workKey" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "rootNumber" INTEGER,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_run_ledger_pkey" PRIMARY KEY ("workKey")
);

-- CreateTable
CREATE TABLE "rate_limits" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_syncToken_idx" ON "users"("syncToken");

-- CreateIndex
CREATE INDEX "ai_conversations_userId_archived_updatedAt_idx" ON "ai_conversations"("userId", "archived", "updatedAt");

-- CreateIndex
CREATE INDEX "ai_conversations_courseId_idx" ON "ai_conversations"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_messages_proposalId_key" ON "ai_messages"("proposalId");

-- CreateIndex
CREATE INDEX "ai_messages_conversationId_createdAt_idx" ON "ai_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "usage_records_userId_idx" ON "usage_records"("userId");

-- CreateIndex
CREATE INDEX "usage_records_createdAt_idx" ON "usage_records"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_providerAccountId_key" ON "accounts"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_sessionToken_key" ON "sessions"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_token_key" ON "verification_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_identifier_token_key" ON "verification_tokens"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "courses_code_key" ON "courses"("code");

-- CreateIndex
CREATE UNIQUE INDEX "user_courses_userId_courseId_key" ON "user_courses"("userId", "courseId");

-- CreateIndex
CREATE INDEX "course_curriculum_scopes_subjectCode_idx" ON "course_curriculum_scopes"("subjectCode");

-- CreateIndex
CREATE INDEX "course_curriculum_scopes_board_qualification_level_subjectC_idx" ON "course_curriculum_scopes"("board", "qualification", "level", "subjectCode");

-- CreateIndex
CREATE UNIQUE INDEX "course_curriculum_scopes_courseId_board_qualification_level_key" ON "course_curriculum_scopes"("courseId", "board", "qualification", "level", "subjectCode");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_code_key" ON "subjects"("code");

-- CreateIndex
CREATE INDEX "subjects_board_qualification_idx" ON "subjects"("board", "qualification");

-- CreateIndex
CREATE UNIQUE INDEX "past_papers_filepath_key" ON "past_papers"("filepath");

-- CreateIndex
CREATE INDEX "past_papers_subjectId_idx" ON "past_papers"("subjectId");

-- CreateIndex
CREATE INDEX "past_papers_year_idx" ON "past_papers"("year");

-- CreateIndex
CREATE INDEX "past_papers_subjectId_year_session_paperNumber_variant_docT_idx" ON "past_papers"("subjectId", "year", "session", "paperNumber", "variant", "docType");

-- CreateIndex
CREATE INDEX "past_papers_subjectId_year_session_idx" ON "past_papers"("subjectId", "year", "session");

-- CreateIndex
CREATE INDEX "past_papers_filename_idx" ON "past_papers"("filename");

-- CreateIndex
CREATE INDEX "past_paper_questions_paperId_idx" ON "past_paper_questions"("paperId");

-- CreateIndex
CREATE INDEX "past_paper_questions_number_part_subPart_idx" ON "past_paper_questions"("number", "part", "subPart");

-- CreateIndex
CREATE INDEX "past_paper_questions_docType_idx" ON "past_paper_questions"("docType");

-- CreateIndex
CREATE INDEX "past_paper_questions_topic_idx" ON "past_paper_questions"("topic");

-- CreateIndex
CREATE UNIQUE INDEX "learning_profiles_userId_key" ON "learning_profiles"("userId");

-- CreateIndex
CREATE INDEX "study_tasks_userId_dueAt_idx" ON "study_tasks"("userId", "dueAt");

-- CreateIndex
CREATE INDEX "study_tasks_userId_status_idx" ON "study_tasks"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rag_documents_documentKey_key" ON "rag_documents"("documentKey");

-- CreateIndex
CREATE INDEX "rag_documents_sourceType_sourceRecordId_idx" ON "rag_documents"("sourceType", "sourceRecordId");

-- CreateIndex
CREATE INDEX "rag_documents_ownerId_visibility_idx" ON "rag_documents"("ownerId", "visibility");

-- CreateIndex
CREATE INDEX "rag_documents_board_qualification_level_subjectCode_idx" ON "rag_documents"("board", "qualification", "level", "subjectCode");

-- CreateIndex
CREATE INDEX "rag_documents_year_documentType_idx" ON "rag_documents"("year", "documentType");

-- CreateIndex
CREATE INDEX "rag_chunks_documentId_idx" ON "rag_chunks"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "rag_chunks_documentId_ordinal_key" ON "rag_chunks"("documentId", "ordinal");

-- CreateIndex
CREATE INDEX "rag_corpus_manifests_board_qualification_level_subjectCode_idx" ON "rag_corpus_manifests"("board", "qualification", "level", "subjectCode");

-- CreateIndex
CREATE UNIQUE INDEX "rag_corpus_manifests_board_qualification_level_subjectCode__key" ON "rag_corpus_manifests"("board", "qualification", "level", "subjectCode", "year", "documentType");

-- CreateIndex
CREATE UNIQUE INDEX "ai_action_proposals_idempotencyKey_key" ON "ai_action_proposals"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ai_action_proposals_ownerId_status_expiresAt_idx" ON "ai_action_proposals"("ownerId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "ai_action_proposals_conversationId_idx" ON "ai_action_proposals"("conversationId");

-- CreateIndex
CREATE INDEX "review_items_userId_status_nextReviewAt_idx" ON "review_items"("userId", "status", "nextReviewAt");

-- CreateIndex
CREATE UNIQUE INDEX "review_items_userId_questionId_key" ON "review_items"("userId", "questionId");

-- CreateIndex
CREATE INDEX "question_images_questionId_idx" ON "question_images"("questionId");

-- CreateIndex
CREATE INDEX "past_paper_attempts_userId_idx" ON "past_paper_attempts"("userId");

-- CreateIndex
CREATE INDEX "past_paper_attempts_questionId_idx" ON "past_paper_attempts"("questionId");

-- CreateIndex
CREATE INDEX "mock_exams_userId_idx" ON "mock_exams"("userId");

-- CreateIndex
CREATE INDEX "mock_exam_items_mockExamId_idx" ON "mock_exam_items"("mockExamId");

-- CreateIndex
CREATE INDEX "notes_userId_updatedAt_idx" ON "notes"("userId", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "shared_notes_userId_idx" ON "shared_notes"("userId");

-- CreateIndex
CREATE INDEX "shared_notes_visibility_createdAt_idx" ON "shared_notes"("visibility", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "note_ratings_sharedNoteId_userId_key" ON "note_ratings"("sharedNoteId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "bookmarks_userId_questionId_key" ON "bookmarks"("userId", "questionId");

-- CreateIndex
CREATE INDEX "past_paper_bookmarks_userId_idx" ON "past_paper_bookmarks"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "past_paper_bookmarks_userId_questionId_key" ON "past_paper_bookmarks"("userId", "questionId");

-- CreateIndex
CREATE UNIQUE INDEX "follows_followerId_followingId_key" ON "follows"("followerId", "followingId");

-- CreateIndex
CREATE INDEX "notebooks_userId_idx" ON "notebooks"("userId");

-- CreateIndex
CREATE INDEX "sections_notebookId_order_idx" ON "sections"("notebookId", "order");

-- CreateIndex
CREATE INDEX "pages_sectionId_order_idx" ON "pages"("sectionId", "order");

-- CreateIndex
CREATE INDEX "pages_favorite_idx" ON "pages"("favorite");

-- CreateIndex
CREATE INDEX "pages_archived_idx" ON "pages"("archived");

-- CreateIndex
CREATE INDEX "page_snapshots_pageId_createdAt_idx" ON "page_snapshots"("pageId", "createdAt");

-- CreateIndex
CREATE INDEX "page_collaborators_userId_idx" ON "page_collaborators"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "page_collaborators_pageId_userId_key" ON "page_collaborators"("pageId", "userId");

-- CreateIndex
CREATE INDEX "page_comments_pageId_resolved_createdAt_idx" ON "page_comments"("pageId", "resolved", "createdAt");

-- CreateIndex
CREATE INDEX "page_presences_pageId_lastSeenAt_idx" ON "page_presences"("pageId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "page_presences_pageId_userId_key" ON "page_presences"("pageId", "userId");

-- CreateIndex
CREATE INDEX "page_awareness_pageId_lastSeenAt_idx" ON "page_awareness"("pageId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "page_awareness_pageId_userId_key" ON "page_awareness"("pageId", "userId");

-- CreateIndex
CREATE INDEX "discussion_threads_subjectId_idx" ON "discussion_threads"("subjectId");

-- CreateIndex
CREATE INDEX "discussion_threads_userId_idx" ON "discussion_threads"("userId");

-- CreateIndex
CREATE INDEX "discussion_threads_category_idx" ON "discussion_threads"("category");

-- CreateIndex
CREATE INDEX "discussion_threads_hidden_idx" ON "discussion_threads"("hidden");

-- CreateIndex
CREATE INDEX "discussion_posts_threadId_idx" ON "discussion_posts"("threadId");

-- CreateIndex
CREATE INDEX "discussion_posts_userId_idx" ON "discussion_posts"("userId");

-- CreateIndex
CREATE INDEX "discussion_posts_hidden_idx" ON "discussion_posts"("hidden");

-- CreateIndex
CREATE INDEX "discussion_votes_threadId_idx" ON "discussion_votes"("threadId");

-- CreateIndex
CREATE INDEX "discussion_votes_postId_idx" ON "discussion_votes"("postId");

-- CreateIndex
CREATE UNIQUE INDEX "discussion_votes_userId_threadId_key" ON "discussion_votes"("userId", "threadId");

-- CreateIndex
CREATE UNIQUE INDEX "discussion_votes_userId_postId_key" ON "discussion_votes"("userId", "postId");

-- CreateIndex
CREATE INDEX "discussion_flags_status_createdAt_idx" ON "discussion_flags"("status", "createdAt");

-- CreateIndex
CREATE INDEX "discussion_flags_threadId_idx" ON "discussion_flags"("threadId");

-- CreateIndex
CREATE INDEX "discussion_flags_postId_idx" ON "discussion_flags"("postId");

-- CreateIndex
CREATE UNIQUE INDEX "discussion_flags_reporterId_threadId_key" ON "discussion_flags"("reporterId", "threadId");

-- CreateIndex
CREATE UNIQUE INDEX "discussion_flags_reporterId_postId_key" ON "discussion_flags"("reporterId", "postId");

-- CreateIndex
CREATE INDEX "notifications_userId_idx" ON "notifications"("userId");

-- CreateIndex
CREATE INDEX "notifications_userId_read_idx" ON "notifications"("userId", "read");

-- CreateIndex
CREATE INDEX "notifications_createdAt_idx" ON "notifications"("createdAt");

-- CreateIndex
CREATE INDEX "school_resources_subject_idx" ON "school_resources"("subject");

-- CreateIndex
CREATE INDEX "school_resources_category_idx" ON "school_resources"("category");

-- CreateIndex
CREATE INDEX "school_resources_createdAt_idx" ON "school_resources"("createdAt");

-- CreateIndex
CREATE INDEX "announcements_published_idx" ON "announcements"("published");

-- CreateIndex
CREATE INDEX "announcements_publishedAt_idx" ON "announcements"("publishedAt");

-- CreateIndex
CREATE INDEX "announcements_audience_idx" ON "announcements"("audience");

-- CreateIndex
CREATE INDEX "note_collaborators_noteId_idx" ON "note_collaborators"("noteId");

-- CreateIndex
CREATE INDEX "note_collaborators_userId_idx" ON "note_collaborators"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "note_collaborators_noteId_userId_key" ON "note_collaborators"("noteId", "userId");

-- CreateIndex
CREATE INDEX "daily_challenge_attempts_dateKey_idx" ON "daily_challenge_attempts"("dateKey");

-- CreateIndex
CREATE UNIQUE INDEX "daily_challenge_attempts_userId_dateKey_key" ON "daily_challenge_attempts"("userId", "dateKey");

-- CreateIndex
CREATE INDEX "competition_questions_competition_idx" ON "competition_questions"("competition");

-- CreateIndex
CREATE INDEX "competition_questions_yearLabel_idx" ON "competition_questions"("yearLabel");

-- CreateIndex
CREATE INDEX "competition_questions_paper_idx" ON "competition_questions"("paper");

-- CreateIndex
CREATE UNIQUE INDEX "competition_questions_competition_code_key" ON "competition_questions"("competition", "code");

-- CreateIndex
CREATE INDEX "cloud_documents_ownerId_updatedAt_idx" ON "cloud_documents"("ownerId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "cloud_documents_ownerId_clientId_key" ON "cloud_documents"("ownerId", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_subjects_board_code_level_key" ON "bank_subjects"("board", "code", "level");

-- CreateIndex
CREATE INDEX "bank_papers_subjectId_idx" ON "bank_papers"("subjectId");

-- CreateIndex
CREATE INDEX "bank_papers_board_year_session_paperNumber_variant_docType_idx" ON "bank_papers"("board", "year", "session", "paperNumber", "variant", "docType");

-- CreateIndex
CREATE INDEX "bank_papers_sourceSha256_idx" ON "bank_papers"("sourceSha256");

-- CreateIndex
CREATE UNIQUE INDEX "bank_papers_sourcePath_key" ON "bank_papers"("sourcePath");

-- CreateIndex
CREATE INDEX "bank_questions_paperId_idx" ON "bank_questions"("paperId");

-- CreateIndex
CREATE INDEX "bank_questions_status_idx" ON "bank_questions"("status");

-- CreateIndex
CREATE INDEX "bank_questions_difficulty_idx" ON "bank_questions"("difficulty");

-- CreateIndex
CREATE UNIQUE INDEX "bank_questions_paperId_rootNumber_key" ON "bank_questions"("paperId", "rootNumber");

-- CreateIndex
CREATE UNIQUE INDEX "bank_mark_schemes_questionId_key" ON "bank_mark_schemes"("questionId");

-- CreateIndex
CREATE INDEX "bank_mark_schemes_questionId_idx" ON "bank_mark_schemes"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_mark_schemes_paperId_rootNumber_key" ON "bank_mark_schemes"("paperId", "rootNumber");

-- CreateIndex
CREATE UNIQUE INDEX "bank_assets_sha256_key" ON "bank_assets"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "bank_topics_subjectId_name_key" ON "bank_topics"("subjectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "bank_tags_slug_key" ON "bank_tags"("slug");

-- CreateIndex
CREATE INDEX "bank_question_tags_tagId_idx" ON "bank_question_tags"("tagId");

-- CreateIndex
CREATE INDEX "bank_review_flags_questionId_idx" ON "bank_review_flags"("questionId");

-- CreateIndex
CREATE INDEX "bank_review_flags_status_issueType_idx" ON "bank_review_flags"("status", "issueType");

-- CreateIndex
CREATE INDEX "bank_run_ledger_sourceSha256_idx" ON "bank_run_ledger"("sourceSha256");

-- CreateIndex
CREATE INDEX "bank_run_ledger_status_stage_idx" ON "bank_run_ledger"("status", "stage");

-- CreateIndex
CREATE INDEX "rate_limits_resetAt_idx" ON "rate_limits"("resetAt");

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "ai_action_proposals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_courses" ADD CONSTRAINT "user_courses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_courses" ADD CONSTRAINT "user_courses_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_curriculum_scopes" ADD CONSTRAINT "course_curriculum_scopes_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "past_papers" ADD CONSTRAINT "past_papers_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "past_paper_questions" ADD CONSTRAINT "past_paper_questions_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "past_papers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_profiles" ADD CONSTRAINT "learning_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_tasks" ADD CONSTRAINT "study_tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_tasks" ADD CONSTRAINT "study_tasks_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "past_paper_questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_documents" ADD CONSTRAINT "rag_documents_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rag_chunks" ADD CONSTRAINT "rag_chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "rag_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_action_proposals" ADD CONSTRAINT "ai_action_proposals_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_action_proposals" ADD CONSTRAINT "ai_action_proposals_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "past_paper_questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_images" ADD CONSTRAINT "question_images_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "past_paper_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "past_paper_attempts" ADD CONSTRAINT "past_paper_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "past_paper_attempts" ADD CONSTRAINT "past_paper_attempts_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "past_paper_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_exams" ADD CONSTRAINT "mock_exams_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_exam_items" ADD CONSTRAINT "mock_exam_items_mockExamId_fkey" FOREIGN KEY ("mockExamId") REFERENCES "mock_exams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mock_exam_items" ADD CONSTRAINT "mock_exam_items_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "past_paper_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_attempts" ADD CONSTRAINT "question_attempts_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "note_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_folders" ADD CONSTRAINT "note_folders_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "note_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_notes" ADD CONSTRAINT "shared_notes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_comments" ADD CONSTRAINT "note_comments_sharedNoteId_fkey" FOREIGN KEY ("sharedNoteId") REFERENCES "shared_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_comments" ADD CONSTRAINT "note_comments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_ratings" ADD CONSTRAINT "note_ratings_sharedNoteId_fkey" FOREIGN KEY ("sharedNoteId") REFERENCES "shared_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_ratings" ADD CONSTRAINT "note_ratings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "past_paper_bookmarks" ADD CONSTRAINT "past_paper_bookmarks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "past_paper_bookmarks" ADD CONSTRAINT "past_paper_bookmarks_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "past_paper_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_sessions" ADD CONSTRAINT "study_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follows" ADD CONSTRAINT "follows_followingId_fkey" FOREIGN KEY ("followingId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notebooks" ADD CONSTRAINT "notebooks_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_notebookId_fkey" FOREIGN KEY ("notebookId") REFERENCES "notebooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_snapshots" ADD CONSTRAINT "page_snapshots_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_snapshots" ADD CONSTRAINT "page_snapshots_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_collaborators" ADD CONSTRAINT "page_collaborators_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_collaborators" ADD CONSTRAINT "page_collaborators_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_comments" ADD CONSTRAINT "page_comments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_presences" ADD CONSTRAINT "page_presences_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_presences" ADD CONSTRAINT "page_presences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_awareness" ADD CONSTRAINT "page_awareness_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "page_awareness" ADD CONSTRAINT "page_awareness_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_threads" ADD CONSTRAINT "discussion_threads_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_threads" ADD CONSTRAINT "discussion_threads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_posts" ADD CONSTRAINT "discussion_posts_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "discussion_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_posts" ADD CONSTRAINT "discussion_posts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_posts" ADD CONSTRAINT "discussion_posts_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "discussion_posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_votes" ADD CONSTRAINT "discussion_votes_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "discussion_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_votes" ADD CONSTRAINT "discussion_votes_postId_fkey" FOREIGN KEY ("postId") REFERENCES "discussion_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_votes" ADD CONSTRAINT "discussion_votes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_flags" ADD CONSTRAINT "discussion_flags_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "discussion_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_flags" ADD CONSTRAINT "discussion_flags_postId_fkey" FOREIGN KEY ("postId") REFERENCES "discussion_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_flags" ADD CONSTRAINT "discussion_flags_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discussion_flags" ADD CONSTRAINT "discussion_flags_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "school_resources" ADD CONSTRAINT "school_resources_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_collaborators" ADD CONSTRAINT "note_collaborators_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_collaborators" ADD CONSTRAINT "note_collaborators_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_challenge_attempts" ADD CONSTRAINT "daily_challenge_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_challenge_attempts" ADD CONSTRAINT "daily_challenge_attempts_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "past_paper_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cloud_documents" ADD CONSTRAINT "cloud_documents_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_papers" ADD CONSTRAINT "bank_papers_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "bank_subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_questions" ADD CONSTRAINT "bank_questions_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "bank_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_questions" ADD CONSTRAINT "bank_questions_screenshotId_fkey" FOREIGN KEY ("screenshotId") REFERENCES "bank_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_mark_schemes" ADD CONSTRAINT "bank_mark_schemes_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "bank_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_mark_schemes" ADD CONSTRAINT "bank_mark_schemes_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "bank_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_question_assets" ADD CONSTRAINT "bank_question_assets_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "bank_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_question_assets" ADD CONSTRAINT "bank_question_assets_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "bank_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_mark_scheme_assets" ADD CONSTRAINT "bank_mark_scheme_assets_markSchemeId_fkey" FOREIGN KEY ("markSchemeId") REFERENCES "bank_mark_schemes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_mark_scheme_assets" ADD CONSTRAINT "bank_mark_scheme_assets_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "bank_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_topics" ADD CONSTRAINT "bank_topics_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "bank_subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_question_topics" ADD CONSTRAINT "bank_question_topics_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "bank_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_question_topics" ADD CONSTRAINT "bank_question_topics_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "bank_topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_question_tags" ADD CONSTRAINT "bank_question_tags_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "bank_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_question_tags" ADD CONSTRAINT "bank_question_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "bank_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_review_flags" ADD CONSTRAINT "bank_review_flags_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "bank_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_review_flags" ADD CONSTRAINT "bank_review_flags_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "bank_papers"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Full-text search infrastructure.
--
-- None of this is expressible in schema.prisma, so `prisma migrate diff` does
-- not emit it and `prisma db push` will not create it. It has to be appended by
-- hand, and re-appended if this baseline is ever regenerated.
--
-- lib/rag.ts queries `rag_chunks."searchVector" @@ to_tsquery('english', …)`
-- directly. Without the column below, every RAG/copilot search fails with
-- `column c.searchVector does not exist` — the AI study search simply stops
-- working, with nothing in schema.prisma to hint at why.
--
-- Originally from 20260723160000_platform_rag_copilot (see
-- prisma/migrations-legacy/).
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Generated column: Postgres maintains it from "content" on every write.
ALTER TABLE "rag_chunks"
  ADD COLUMN IF NOT EXISTS "searchVector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("content", ''))) STORED;

CREATE INDEX IF NOT EXISTS "rag_chunks_searchVector_idx"
  ON "rag_chunks" USING GIN ("searchVector");
CREATE INDEX IF NOT EXISTS "rag_chunks_content_trgm_idx"
  ON "rag_chunks" USING GIN ("content" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "rag_documents_title_trgm_idx"
  ON "rag_documents" USING GIN ("title" gin_trgm_ops);
