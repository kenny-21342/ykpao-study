ALTER TABLE "courses"
  ADD COLUMN "catalogManaged" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "user_courses"
  ADD COLUMN "targetGrade" TEXT,
  ADD COLUMN "examDate" TIMESTAMP(3),
  ADD COLUMN "currentLevel" TEXT,
  ADD COLUMN "recentResult" TEXT,
  ADD COLUMN "personalizationEnabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "ai_conversations" ADD COLUMN "courseId" TEXT;

CREATE TABLE "course_curriculum_scopes" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "board" TEXT NOT NULL,
  "qualification" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "subjectCode" TEXT NOT NULL,
  CONSTRAINT "course_curriculum_scopes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "course_curriculum_scopes_courseId_board_qualification_level_subjectCode_key"
  ON "course_curriculum_scopes"("courseId", "board", "qualification", "level", "subjectCode");
CREATE INDEX "course_curriculum_scopes_subjectCode_idx"
  ON "course_curriculum_scopes"("subjectCode");
CREATE INDEX "course_curriculum_scopes_board_qualification_level_subjectCode_idx"
  ON "course_curriculum_scopes"("board", "qualification", "level", "subjectCode");
CREATE INDEX "ai_conversations_courseId_idx" ON "ai_conversations"("courseId");

ALTER TABLE "course_curriculum_scopes" ADD CONSTRAINT "course_curriculum_scopes_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Only the old controlled presets have deterministic syllabus mappings. Other
-- courses remain enrolled but unmapped so an administrator or student can
-- correct them without an unsafe guess.
INSERT INTO "course_curriculum_scopes" ("id", "courseId", "board", "qualification", "level", "subjectCode")
SELECT 'scope-' || c."id", c."id", 'Cambridge',
  CASE WHEN c."code" LIKE '%-AL' THEN 'Cambridge AS & A Level' ELSE 'Cambridge IGCSE' END,
  CASE WHEN c."code" LIKE '%-AL' THEN 'A Level' ELSE 'IGCSE' END,
  CASE c."code"
    WHEN 'MATH-IG' THEN '0580'
    WHEN 'ADD-MATH-IG' THEN '0606'
    WHEN 'PHYS-IG' THEN '0625'
    WHEN 'CHEM-IG' THEN '0620'
    WHEN 'BIO-IG' THEN '0610'
    WHEN 'ECON-IG' THEN '0455'
    WHEN 'CS-IG' THEN '0478'
    WHEN 'ENG-LANG-IG' THEN '0500'
    WHEN 'ENG-LIT-IG' THEN '0475'
    WHEN 'GEOG-IG' THEN '0460'
    WHEN 'HIST-IG' THEN '0470'
    WHEN 'BUS-IG' THEN '0450'
    WHEN 'MATH-AL' THEN '9709'
    WHEN 'PHYS-AL' THEN '9702'
    WHEN 'CHEM-AL' THEN '9701'
    WHEN 'BIO-AL' THEN '9700'
    WHEN 'ECON-AL' THEN '9708'
    WHEN 'FMATH-AL' THEN '9231'
  END
FROM "courses" c
WHERE c."code" IN (
  'MATH-IG', 'ADD-MATH-IG', 'PHYS-IG', 'CHEM-IG', 'BIO-IG', 'ECON-IG',
  'CS-IG', 'ENG-LANG-IG', 'ENG-LIT-IG', 'GEOG-IG', 'HIST-IG', 'BUS-IG',
  'MATH-AL', 'PHYS-AL', 'CHEM-AL', 'BIO-AL', 'ECON-AL', 'FMATH-AL'
)
ON CONFLICT DO NOTHING;

UPDATE "courses" SET "catalogManaged" = true
WHERE "code" IN (
  'MATH-IG', 'ADD-MATH-IG', 'PHYS-IG', 'CHEM-IG', 'BIO-IG', 'ECON-IG',
  'CS-IG', 'ENG-LANG-IG', 'ENG-LIT-IG', 'GEOG-IG', 'HIST-IG', 'BUS-IG',
  'MATH-AL', 'PHYS-AL', 'CHEM-AL', 'BIO-AL', 'ECON-AL', 'FMATH-AL'
);

-- Repair indexed metadata that previously copied Course.code into the
-- syllabus-code column. Course.code remains an internal catalog identifier.
UPDATE "rag_documents" document
SET
  "board" = scope."board",
  "qualification" = scope."qualification",
  "level" = scope."level",
  "subjectCode" = scope."subjectCode",
  "metadata" = CASE
    WHEN document."sourceType" IN ('note', 'cloud-note', 'textbook')
      THEN document."metadata" || jsonb_build_object('courseId', course."id", 'crossCourse', false)
    ELSE document."metadata"
  END,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "courses" course
JOIN "course_curriculum_scopes" scope ON scope."courseId" = course."id"
WHERE lower(document."subjectCode") = lower(course."code");

-- Migrate legacy single-subject goals only when the user's sole enrollment is
-- compatible with the profile metadata. The legacy fields remain untouched.
UPDATE "user_courses" uc
SET
  "targetGrade" = lp."targetGrade",
  "examDate" = lp."examDate",
  "currentLevel" = lp."currentLevel",
  "recentResult" = lp."recentResult"
FROM "learning_profiles" lp
WHERE lp."userId" = uc."userId"
  AND (SELECT COUNT(*) FROM "user_courses" only_uc WHERE only_uc."userId" = uc."userId") = 1
  AND EXISTS (
    SELECT 1 FROM "course_curriculum_scopes" scope
    WHERE scope."courseId" = uc."courseId"
      AND (
        lp."subjectCode" IS NULL
        OR lower(scope."subjectCode") = lower(lp."subjectCode")
        OR EXISTS (
          SELECT 1 FROM "courses" legacy_course
          WHERE legacy_course."id" = uc."courseId"
            AND lower(legacy_course."code") = lower(lp."subjectCode")
        )
      )
      AND (lp."board" IS NULL OR lower(scope."board") = lower(lp."board"))
      AND (lp."qualification" IS NULL OR lower(scope."qualification") = lower(lp."qualification"))
      AND (lp."level" IS NULL OR lower(scope."level") = lower(lp."level"))
  );
