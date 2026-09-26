import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';
import { validResourceFolderName } from '@/lib/school-resource-folders';

export const dynamic = 'force-dynamic';

// PATCH /api/school-resource-folders/[id] — rename or move a folder.
//
// Admin-only, unlike POST on the collection route. Creating a folder is part of
// uploading and every signed-in user does it; reorganising or destroying the
// shared tree is not. `app/api/admin/resources/[id]/route.ts` already requires
// an admin to edit or delete a single resource, so leaving these two open meant
// a student could not delete one file but could rename, move or (below)
// cascade-delete the whole structure those files live in -- over HTTP, with no
// UI for it and no record of who did it, since the model has no owner column.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const { id } = await params;
    const body = (await req.json()) ?? {};
    const { name, parentId } = body as { name?: string; parentId?: string | null };

    if (name !== undefined && !validResourceFolderName(name.trim())) {
      return NextResponse.json({ error: 'Invalid folder name' }, { status: 400 });
    }

    const existing = await prisma.schoolResourceFolder.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Folder not found' }, { status: 404 });

    if (parentId !== undefined && parentId !== null) {
      if (parentId === id) {
        return NextResponse.json({ error: 'A folder cannot be its own parent' }, { status: 400 });
      }
      // Walk the proposed new parent's ancestry to reject moving a folder
      // into one of its own descendants, which would otherwise orphan the
      // whole subtree into an unreachable cycle.
      let cursor: string | null = parentId;
      while (cursor) {
        if (cursor === id) {
          return NextResponse.json({ error: 'Cannot move a folder into its own subfolder' }, { status: 400 });
        }
        const node: { parentId: string | null } | null = await prisma.schoolResourceFolder.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        });
        if (!node) return NextResponse.json({ error: 'Parent folder not found' }, { status: 404 });
        cursor = node.parentId;
      }
    }

    const folder = await prisma.schoolResourceFolder.update({
      where: { id },
      data: {
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(parentId !== undefined ? { parentId: parentId || null } : {}),
      },
      select: { id: true, name: true, parentId: true },
    });
    return NextResponse.json({ folder });
  } catch (error) {
    console.error('Failed to update school resource folder:', error);
    await reportError(error, { routePath: '/api/school-resource-folders/[id]', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update folder' },
      { status: 500 }
    );
  }
}

// DELETE /api/school-resource-folders/[id] — delete a folder and its
// subfolders. Files inside are NOT deleted: the folderId FK is ON DELETE
// SET NULL, so they fall back to the root listing rather than disappearing.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const { id } = await params;
    const existing = await prisma.schoolResourceFolder.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Folder not found' }, { status: 404 });

    // Report the reach: the parent FK cascades, so this removes every
    // descendant folder too, and the caller otherwise cannot tell whether it
    // deleted one folder or a subtree.
    const subtree = await prisma.$queryRaw<{ n: bigint }[]>`
      WITH RECURSIVE descendants AS (
        SELECT id FROM school_resource_folders WHERE id = ${id}
        UNION ALL
        SELECT f.id FROM school_resource_folders f JOIN descendants d ON f."parentId" = d.id
      )
      SELECT COUNT(*)::bigint AS n FROM descendants`;
    await prisma.schoolResourceFolder.delete({ where: { id } });
    return NextResponse.json({ status: 'deleted', foldersRemoved: Number(subtree[0]?.n ?? 1) });
  } catch (error) {
    console.error('Failed to delete school resource folder:', error);
    await reportError(error, { routePath: '/api/school-resource-folders/[id]', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete folder' },
      { status: 500 }
    );
  }
}
