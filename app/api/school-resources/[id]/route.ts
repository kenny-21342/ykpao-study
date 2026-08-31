import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { deleteSchoolResource } from '@/lib/school-resources';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

// GET /api/school-resources/[id] — fetch one (also bumps download count when
// ?download=1 is passed so the UI can track popularity).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // School resources carry uploader identity and a direct fileUrl, and the
    // ?download=1 counter is writable — none of that should be reachable
    // anonymously.
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const download = new URL(req.url).searchParams.get('download') === '1';

    const resource = await prisma.schoolResource.findUnique({
      where: { id },
      include: { uploader: { select: { id: true, name: true, image: true } } },
    });
    if (!resource) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    if (download) {
      await prisma.schoolResource.update({
        where: { id },
        data: { downloads: { increment: 1 } },
      });
    }

    return NextResponse.json({ resource });
  } catch (error) {
    console.error('Failed to fetch school resource:', error);
    await reportError(error, { routePath: '/api/school-resources/[id]', source: 'route' });
    return NextResponse.json({ error: 'Failed to fetch resource' }, { status: 500 });
  }
}

// DELETE /api/school-resources/[id] — only the uploader can delete.
// The row, the stored file, and the RAG entry all go, via the same helper the
// admin paths use — this route used to skip the storage cleanup.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;

    const existing = await prisma.schoolResource.findFirst({
      where: { id, uploaderId: user.id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Resource not found' }, { status: 404 });
    }

    await deleteSchoolResource(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Failed to delete school resource:', error);
    await reportError(error, { routePath: '/api/school-resources/[id]', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete resource' },
      { status: 500 }
    );
  }
}
