import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

// GET /api/school-resource-folders — direct children of a folder (or root).
// The Browser view in ResourceLibrary.tsx gets this data bundled into
// GET /api/school-resources instead; this route exists for callers (folder
// pickers, the admin console) that need just the folder list with no files.
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parentId = new URL(req.url).searchParams.get('parentId')?.trim() || null;
  const folders = await prisma.schoolResourceFolder.findMany({
    where: { parentId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, parentId: true },
  });
  return NextResponse.json({ folders });
}

// POST /api/school-resource-folders — create an empty folder. Same
// permission level as uploading a resource (any signed-in user): this
// project does not currently gate the Resource Library behind a staff role.
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = (await req.json()) ?? {};
    const { name, parentId } = body as { name?: string; parentId?: string | null };
    const trimmed = name?.trim();
    if (!trimmed) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    if (parentId) {
      const parent = await prisma.schoolResourceFolder.findUnique({ where: { id: parentId } });
      if (!parent) return NextResponse.json({ error: 'Parent folder not found' }, { status: 404 });
    }

    const folder = await prisma.schoolResourceFolder.create({
      data: { name: trimmed, parentId: parentId || null },
      select: { id: true, name: true, parentId: true },
    });
    return NextResponse.json({ folder }, { status: 201 });
  } catch (error) {
    console.error('Failed to create school resource folder:', error);
    await reportError(error, { routePath: '/api/school-resource-folders', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create folder' },
      { status: 500 }
    );
  }
}
