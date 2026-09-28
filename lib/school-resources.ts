import { prisma } from '@/lib/prisma';
import { getStorage } from '@/lib/storage';
import { indexSchoolResource, refreshRagIndex } from '@/lib/rag-index';
import { reportError } from '@/lib/error-reporting';
import type { Prisma } from '@prisma/client';
import { resourceUploadFolderId } from '@/lib/school-resource-upload';
import { findOrCreateResourceFolder, validResourceFolderName } from '@/lib/school-resource-folders';

/**
 * Shared mutation helpers for school resources.
 *
 * There are three delete paths (admin content moderation, the admin resource
 * console, the uploader's own Resource Library) and they must behave
 * identically: row gone, storage object gone, RAG index gone. Before this
 * module the admin path skipped both the storage cleanup and the reindex, so
 * deleting a resource left the file on the bill and `rag_chunks` serving text
 * the student could no longer open.
 *
 * Nothing here checks authorization — the callers own that (requireAdmin, or
 * uploader-only on the self-service route).
 */

/**
 * The URL shapes issued by /api/upload are flat legacy keys and folder keys.
 * Deleting a storage object from a user-controllable URL is only safe behind
 * these exact shapes — the key
 * is derived by dropping the leading slash, and anything else (legacy rows,
 * external URLs, malformed paths) is left alone rather than guessed at.
 */
function storageKeyForUpload(fileUrl: string): string | null {
  if (!fileUrl || fileUrl.includes('..')) return null;
  if (resourceUploadFolderId(fileUrl) === undefined) return null;
  return fileUrl.slice(1); // '/uploads/files/x' -> 'uploads/files/x'
}

/** Best-effort storage delete. A failed delete is reported, never thrown: an
 * orphaned object costs storage, but a dangling row pointing at a deleted
 * file breaks every student who opens the resource. */
async function purgeUploadObject(fileUrl: string, context: string): Promise<void> {
  const key = storageKeyForUpload(fileUrl);
  if (!key) return;
  try {
    await getStorage().delete(key);
  } catch (error) {
    console.error(`[school-resources] storage delete failed (${context}) for ${key}:`, error);
    await reportError(error, { routePath: context, source: 'job' });
  }
}

/** Reindex (or unindex) after any mutation. */
function reindex(id: string): Promise<unknown> {
  return refreshRagIndex(`resource:${id}`, () => indexSchoolResource(id));
}

/**
 * Resolve a "Physics/Unit 3" style relative path into a chain of
 * `SchoolResourceFolder` rows, creating whichever segments don't exist yet,
 * and return the id of the leaf (deepest) folder. Segments are matched
 * case-sensitively by name under their parent -- same as a real filesystem,
 * and simple enough that two uploads of "Physics/Unit 3" always land in the
 * same folder rather than minting duplicates.
 *
 * Each sibling creation is serialized in the database, so concurrent files
 * from one directory reuse the same folder rows.
 */
export async function resolveFolderPath(
  path: string,
  baseFolderId: string | null = null,
  createdById: string | null = null,
): Promise<string | null> {
  const segments = path
    .split('/')
    .map((s) => s.trim());
  if (segments.length > 20 || segments.some((s) => !validResourceFolderName(s))) {
    throw new Error('Invalid resource folder path');
  }
  if (segments.length === 0) return baseFolderId;

  let parentId: string | null = baseFolderId;
  for (const name of segments) {
    parentId = await findOrCreateResourceFolder(name, parentId, createdById);
  }
  return parentId;
}

export type SchoolResourceWithUploader = Prisma.SchoolResourceGetPayload<{
  include: { uploader: { select: { id: true; name: true; image: true } } };
}>;

export type DeleteResult = { status: 'deleted' } | { status: 'not-found' };

/**
 * Delete a school resource completely: the storage object, the row, and the
 * RAG index entry. Storage cleanup is skipped (with a report) for URLs that
 * do not match the known upload shape.
 */
export async function deleteSchoolResource(id: string): Promise<DeleteResult> {
  const existing = await prisma.schoolResource.findUnique({
    where: { id },
    select: { fileUrl: true },
  });
  if (!existing) return { status: 'not-found' };

  await purgeUploadObject(existing.fileUrl, '/lib/school-resources/delete');

  await prisma.schoolResource.delete({ where: { id } });
  await reindex(id);
  return { status: 'deleted' };
}

export type ResourceFileMeta = {
  fileUrl: string;
  fileName: string;
  fileSize?: number;
  mimeType?: string;
};

export type ReplaceResult =
  | { status: 'replaced'; resource: SchoolResourceWithUploader }
  | { status: 'not-found' }
  | { status: 'bad-url' };

/**
 * Point an existing resource at a newly uploaded file, discarding the old one.
 * The new URL is held to the same rule the create endpoint applies: it must
 * point into our own /uploads/ tree, so a row can never be repointed at an
 * arbitrary external or relative path.
 */
export async function replaceSchoolResourceFile(
  id: string,
  file: ResourceFileMeta,
): Promise<ReplaceResult> {
  const fileUrl = file.fileUrl?.trim();
  if (!fileUrl || !fileUrl.startsWith('/uploads/') || fileUrl.includes('..')) {
    return { status: 'bad-url' };
  }

  const existing = await prisma.schoolResource.findUnique({
    where: { id },
    include: { uploader: { select: { id: true, name: true, image: true } } },
  });
  if (!existing) return { status: 'not-found' };

  const resource = await prisma.schoolResource.update({
    where: { id },
    data: {
      fileUrl,
      fileName: file.fileName.trim().slice(0, 200),
      ...(typeof file.fileSize === 'number' ? { fileSize: file.fileSize } : {}),
      ...(file.mimeType ? { mimeType: file.mimeType.slice(0, 100) } : {}),
    },
    include: { uploader: { select: { id: true, name: true, image: true } } },
  });

  // Only after the row points at the new file do we discard the old object — a
  // failed replacement must never leave the resource with neither file. Purging
  // first meant an update that threw (a DB blip, or a row deleted in another
  // tab) left the row pointing at a key that no longer exists, and every
  // student opening that resource got a 404 with no way back to the file.
  await purgeUploadObject(existing.fileUrl, '/lib/school-resources/replace');

  await reindex(id);
  return { status: 'replaced', resource };
}
