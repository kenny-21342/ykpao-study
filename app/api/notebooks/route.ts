import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { pagesInNotebook, purgePageSideEffects } from '@/lib/page-deletion';
import { resolveCourseScope } from '@/lib/course-scope';
import { getLearnerContext, LearnerContextError } from '@/lib/learner-context';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const params = new URL(req.url).searchParams;
    const courseScope = await resolveCourseScope({ userId: user.id, scope: params.get('scope'), courseId: params.get('courseId') });
    const preferenceFilter = courseScope.effectiveScope === 'enrolled' ? { OR: [{ courseId: { in: courseScope.courseIds } }, { courseId: null }] } : {};
    const notebooks = await prisma.notebook.findMany({
      where: { userId: user.id, ...preferenceFilter },
      include: {
        sections: {
          include: {
            pages: {
              orderBy: { order: 'asc' },
              include: {
                collaborators: {
                  include: { user: { select: { id: true, name: true, email: true, image: true } } },
                  orderBy: { createdAt: 'asc' },
                },
              },
            },
          },
          orderBy: { order: 'asc' },
        },
        course: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const sharedPages = await prisma.page.findMany({
      where: { collaborators: { some: { userId: user.id } }, ...(courseScope.effectiveScope === 'enrolled' ? { section: { notebook: preferenceFilter } } : {}) },
      include: {
        collaborators: {
          include: { user: { select: { id: true, name: true, email: true, image: true } } },
          orderBy: { createdAt: 'asc' },
        },
        section: { include: { notebook: { select: { id: true, name: true, color: true, icon: true, course: true } } } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    type SharedPage = (typeof sharedPages)[number] & { accessRole: 'editor' | 'viewer' };
    const sharedSections = new Map<string, {
      id: string;
      name: string;
      order: number;
      pages: SharedPage[];
    }>();
    for (const page of sharedPages) {
      const key = page.section.id;
      const section = sharedSections.get(key) ?? {
        id: `shared-section:${key}`,
        name: `${page.section.notebook.name} / ${page.section.name}`,
        order: sharedSections.size,
        pages: [],
      };
      const role = page.collaborators.find((collaborator) => collaborator.userId === user.id)?.role;
      section.pages.push({ ...page, accessRole: role === 'editor' ? 'editor' : 'viewer' });
      sharedSections.set(key, section);
    }

    const response: Array<unknown> = notebooks.map((notebook) => ({
      ...notebook,
      sections: notebook.sections.map((section) => ({
        ...section,
        pages: section.pages.map((page) => ({ ...page, accessRole: 'owner' as const })),
      })),
    }));
    if (sharedSections.size > 0) {
      response.push({
        id: 'shared-with-me',
        name: 'Shared with me',
        color: '#0f766e',
        icon: '🤝',
        course: null,
        sections: [...sharedSections.values()],
      });
    }
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('Failed to list notebooks:', error);
    await reportError(error, { routePath: '/api/notebooks', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list notebooks' },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) ?? {};
    const { name, color, icon, courseId } = body as {
      name?: string;
      color?: string;
      icon?: string;
      courseId?: string;
    };

    if (!name?.trim()) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (courseId) {
      try { await getLearnerContext({ userId: user.id, explicitCourseId: courseId }); }
      catch (error) { if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status }); throw error; }
    }

    const notebook = await prisma.notebook.create({
      data: {
        userId: user.id,
        name: name.trim(),
        color: color || '#3b82f6',
        icon: icon || '📓',
        courseId: courseId || null,
      },
      include: { sections: { include: { pages: true } } },
    });

    return NextResponse.json(notebook, { status: 201 });
  } catch (error) {
    console.error('Failed to create notebook:', error);
    await reportError(error, { routePath: '/api/notebooks', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create notebook' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/notebooks?notebookId=...
 *
 * Notebooks and sections had no delete at all -- in the API or the UI -- so a
 * notebook created by mistake was permanent. The row cascade to sections and
 * pages is in the schema; what it cannot do is retire each page's cloud mirror
 * and its document in the RAG index, so those are cleared first.
 */
export async function DELETE(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const notebookId = new URL(req.url).searchParams.get('notebookId');
    if (!notebookId) return NextResponse.json({ error: 'notebookId is required' }, { status: 400 });

    // Scoped to the caller: a notebook they do not own is "not found", never
    // a 403 that confirms it exists.
    const notebook = await prisma.notebook.findFirst({
      where: { id: notebookId, userId: user.id },
      select: { id: true },
    });
    if (!notebook) return NextResponse.json({ error: 'Notebook not found' }, { status: 404 });

    const pages = await pagesInNotebook(notebookId, user.id);
    await prisma.notebook.delete({ where: { id: notebookId } });
    await purgePageSideEffects(pages);

    return NextResponse.json({ ok: true, deletedPages: pages.length });
  } catch (error) {
    console.error('Failed to delete notebook:', error);
    await reportError(error, { routePath: '/api/notebooks', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete notebook' },
      { status: 500 }
    );
  }
}
