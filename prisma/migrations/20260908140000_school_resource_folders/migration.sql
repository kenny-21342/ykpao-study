-- A real folder tree for school resources, replacing the
-- "From folder upload: <path>" marker stuffed into `description` and
-- re-parsed client-side on every render (lib/upload-constants.ts's
-- FOLDER_UPLOAD_PREFIX). Mirrors the existing note_folders self-referential
-- shape, but with no userId: the resource library is one shared school-wide
-- space, so its folders are shared too.

CREATE TABLE "school_resource_folders" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "school_resource_folders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "school_resource_folders_parentId_idx" ON "school_resource_folders"("parentId");

ALTER TABLE "school_resource_folders" ADD CONSTRAINT "school_resource_folders_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "school_resource_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable: an unfiled resource lives at the library root, same as before
-- this migration existed.
ALTER TABLE "school_resources" ADD COLUMN "folderId" TEXT;

CREATE INDEX "school_resources_folderId_idx" ON "school_resources"("folderId");

-- SetNull, not Cascade: deleting a folder is an organizational action and
-- must never delete the files inside it -- they fall back to the root
-- listing instead.
ALTER TABLE "school_resources" ADD CONSTRAINT "school_resources_folderId_fkey"
    FOREIGN KEY ("folderId") REFERENCES "school_resource_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
