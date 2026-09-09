import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { pagesInSection, purgePageSideEffects } from '@/lib/page-deletion';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

// POST /api/sections — create a section inside a notebook owned by the user
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) ?? {};
    const { notebookId, name } = body as { notebookId?: string; name?: string };

    if (!notebookId) {
      return NextResponse.json({ error: 'notebookId is required' }, { status: 400 });
    }
    if (!name?.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    // Ownership check: notebook must belong to the authenticated user
    const notebook = await prisma.notebook.findFirst({
      where: { id: notebookId, userId: user.id },
      select: { id: true },
    });
    if (!notebook) {
      return NextResponse.json({ error: 'Notebook not found' }, { status: 404 });
    }

    const maxOrder = await prisma.section.findFirst({
      where: { notebookId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });

    const section = await prisma.section.create({
      data: {
        notebookId,
        name: name.trim(),
        order: (maxOrder?.order ?? -1) + 1,
      },
      include: { pages: true },
    });

    return NextResponse.json(section, { status: 201 });
  } catch (error) {
    console.error('Failed to create section:', error);
    await reportError(error, { routePath: '/api/sections', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create section' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/sections?sectionId=...
 *
 * Same shape as the notebook delete above, and for the same reason: the
 * schema cascades the pages away, but each page's cloud mirror and RAG
 * document have to be retired explicitly or the deleted pages stay
 * searchable.
 */
export async function DELETE(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const sectionId = new URL(req.url).searchParams.get('sectionId');
    if (!sectionId) return NextResponse.json({ error: 'sectionId is required' }, { status: 400 });

    const section = await prisma.section.findFirst({
      where: { id: sectionId, notebook: { userId: user.id } },
      select: { id: true },
    });
    if (!section) return NextResponse.json({ error: 'Section not found' }, { status: 404 });

    const pages = await pagesInSection(sectionId, user.id);
    await prisma.section.delete({ where: { id: sectionId } });
    await purgePageSideEffects(pages);

    return NextResponse.json({ ok: true, deletedPages: pages.length });
  } catch (error) {
    console.error('Failed to delete section:', error);
    await reportError(error, { routePath: '/api/sections', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete section' },
      { status: 500 }
    );
  }
}
