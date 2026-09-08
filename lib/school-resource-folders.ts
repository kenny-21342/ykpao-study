import { prisma } from '@/lib/prisma';

/**
 * The human-readable "Physics/Unit 3" path for a folder, walking the parent
 * chain up to the root. Used for display (search snippets, breadcrumbs)
 * wherever a folder id alone isn't enough context.
 *
 * Kept in its own module rather than lib/school-resources.ts: that file is
 * imported by lib/rag-index.ts (for indexSchoolResource), and this helper is
 * also needed by lib/rag-index.ts to build a resource's search title, so
 * either home would create an import cycle between the two.
 *
 * Bounded to 20 hops so a corrupted cycle (which the folder-move route's
 * guard should prevent, but a direct DB edit could still produce) can't
 * loop forever.
 */
export async function folderPathFor(folderId: string | null): Promise<string | null> {
  if (!folderId) return null;
  const segments: string[] = [];
  let currentId: string | null = folderId;
  for (let hops = 0; currentId && hops < 20; hops++) {
    const folder: { name: string; parentId: string | null } | null = await prisma.schoolResourceFolder.findUnique({
      where: { id: currentId },
      select: { name: true, parentId: true },
    });
    if (!folder) break;
    segments.unshift(folder.name);
    currentId = folder.parentId;
  }
  return segments.length > 0 ? segments.join('/') : null;
}
