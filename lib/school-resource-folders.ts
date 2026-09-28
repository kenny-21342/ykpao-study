import { prisma } from '@/lib/prisma';

export function validResourceFolderName(name: string): boolean {
  return name.length > 0 && name.length <= 200 && name !== '.' && name !== '..' &&
    !name.includes('/') && !name.includes('\\') && !/[\x00-\x1f]/.test(name);
}

/** Serialize creation of a particular sibling name so parallel folder uploads
 * reuse one row even before a database uniqueness migration can be deployed.
 *
 * `createdById` attributes a NEW folder to whoever caused it to exist. It is
 * deliberately not written when an existing folder is reused: the first person
 * to make "Physics/Unit 3" is its contributor, and everyone who later uploads
 * into it would otherwise silently take that credit from them. */
export async function findOrCreateResourceFolder(
  name: string,
  parentId: string | null,
  createdById: string | null = null,
): Promise<string> {
  if (!validResourceFolderName(name)) throw new Error('Invalid resource folder name');
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${parentId ?? ''}), hashtext(${name}))::text`;
    const existing = await tx.schoolResourceFolder.findFirst({
      where: { name, parentId }, select: { id: true },
    });
    if (existing) return existing.id;
    const created = await tx.schoolResourceFolder.create({
      data: { name, parentId, createdById }, select: { id: true },
    });
    return created.id;
  });
}

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
