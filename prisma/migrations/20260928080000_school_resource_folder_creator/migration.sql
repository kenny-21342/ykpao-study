-- Attribution for resource folders.
--
-- SchoolResource has recorded `uploaderId` since it was created; folders never
-- recorded anything, so a folder in the shared library had no visible author.
--
-- Nullable with no backfill on purpose: every folder that predates this has no
-- true answer, and attributing them to whoever ran the migration would be a
-- fabricated one. The UI shows nothing rather than a guess.
--
-- ON DELETE SET NULL, not CASCADE: a contributor leaving the school must not
-- delete the folders their work sat in. Mirrors school_resources.folderId,
-- which is SET NULL for the same reason.
ALTER TABLE "school_resource_folders"
  ADD COLUMN "createdById" TEXT;

ALTER TABLE "school_resource_folders"
  ADD CONSTRAINT "school_resource_folders_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "school_resource_folders_createdById_idx"
  ON "school_resource_folders"("createdById");
