import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

// PATCH /api/school-resource-folders/[id] — rename or move a folder.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const body = (await req.json()) ?? {};
    const { name, parentId } = body as { name?: string; parentId?: string | null };

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
        cursor = node?.parentId ?? null;
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
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const existing = await prisma.schoolResourceFolder.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: 'Folder not found' }, { status: 404 });

    await prisma.schoolResourceFolder.delete({ where: { id } });
    return NextResponse.json({ status: 'deleted' });
  } catch (error) {
    console.error('Failed to delete school resource folder:', error);
    await reportError(error, { routePath: '/api/school-resource-folders/[id]', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete folder' },
      { status: 500 }
    );
  }
}
