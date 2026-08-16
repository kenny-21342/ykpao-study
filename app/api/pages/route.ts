import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canEditPage, getPageAccess, syncPageToCloud } from '@/lib/page-access';
import { indexPage, refreshRagIndex } from '@/lib/rag-index';
import { notifyRevision } from '@/lib/page-pubsub';

export const dynamic = 'force-dynamic';

const CreatePage = z.object({
  sectionId: z.string().min(1),
  title: z.string().trim().min(1).max(300),
  content: z.string().max(2_000_000).optional(),
  icon: z.string().max(16).optional(),
  duplicatePageId: z.string().optional(),
});

const UpdatePage = z.object({
  pageId: z.string().min(1),
  baseRevision: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(300).optional(),
  content: z.string().max(2_000_000).optional(),
  icon: z.string().max(16).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  favorite: z.boolean().optional(),
  archived: z.boolean().optional(),
  linkedQuestionIds: z.array(z.number().int().positive()).max(100).optional(),
  splitQuestionId: z.number().int().positive().nullable().optional(),
  sectionId: z.string().min(1).optional(),
  order: z.number().int().nonnegative().optional(),
  createSnapshot: z.boolean().optional(),
  snapshotReason: z.enum(['manual', 'autosave', 'restore']).optional(),
});

const ReorderPages = z.object({
  sectionId: z.string().min(1),
  orderedPageIds: z.array(z.string().min(1)).max(1000),
});

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const pageId = new URL(req.url).searchParams.get('pageId');
  if (!pageId) return NextResponse.json({ error: 'pageId is required' }, { status: 400 });
  const access = await getPageAccess(pageId, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  return NextResponse.json({ ...access.page, accessRole: access.role, collaborators: undefined });
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let parsed: z.infer<typeof CreatePage>;
  try {
    parsed = CreatePage.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid page' }, { status: 400 });
  }

  const section = await prisma.section.findFirst({
    where: { id: parsed.sectionId, notebook: { userId: user.id } },
    select: { id: true },
  });
  if (!section) return NextResponse.json({ error: 'Section not found' }, { status: 404 });

  let duplicate: Awaited<ReturnType<typeof prisma.page.findUnique>> = null;
  if (parsed.duplicatePageId) {
    const access = await getPageAccess(parsed.duplicatePageId, user.id);
    if (!access) return NextResponse.json({ error: 'Source page not found' }, { status: 404 });
    duplicate = access.page;
  }

  const maxOrder = await prisma.page.findFirst({
    where: { sectionId: section.id }, orderBy: { order: 'desc' }, select: { order: true },
  });
  const page = await prisma.page.create({
    data: {
      sectionId: section.id,
      title: parsed.title,
      content: duplicate?.content ?? parsed.content ?? '',
      icon: duplicate?.icon ?? parsed.icon ?? '',
      tags: duplicate?.tags ?? [],
      linkedQuestionIds: duplicate?.linkedQuestionIds ?? [],
      order: (maxOrder?.order ?? -1) + 1,
    },
  });
  await syncPageToCloud({ ...page, ownerId: user.id });
  await refreshRagIndex(`page:${page.id}`, () => indexPage(page.id));
  return NextResponse.json({ ...page, accessRole: 'owner' }, { status: 201 });
}

export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let parsed: z.infer<typeof UpdatePage>;
  try {
    parsed = UpdatePage.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid page update' }, { status: 400 });
  }

  const access = await getPageAccess(parsed.pageId, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  if (!canEditPage(access.role)) return NextResponse.json({ error: 'Read-only page' }, { status: 403 });
  if (parsed.baseRevision !== undefined && parsed.baseRevision !== access.page.revision) {
    return NextResponse.json({ error: 'Page has a newer revision', conflict: true, serverPage: access.page }, { status: 409 });
  }
  if (parsed.sectionId && access.role !== 'owner') {
    return NextResponse.json({ error: 'Only the owner can move a page' }, { status: 403 });
  }
  if (parsed.sectionId) {
    const section = await prisma.section.findFirst({ where: { id: parsed.sectionId, notebook: { userId: user.id } }, select: { id: true } });
    if (!section) return NextResponse.json({ error: 'Target section not found' }, { status: 404 });
  }

  const contentChanged = parsed.content !== undefined && parsed.content !== access.page.content;
  const titleChanged = parsed.title !== undefined && parsed.title !== access.page.title;
  const latestSnapshot = contentChanged || titleChanged
    ? await prisma.pageSnapshot.findFirst({ where: { pageId: access.page.id }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
    : null;
  const snapshotDue = parsed.createSnapshot || !latestSnapshot || Date.now() - latestSnapshot.createdAt.getTime() > 10 * 60_000;

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.page.updateMany({
      where: { id: access.page.id, revision: access.page.revision },
      data: {
        ...(parsed.title !== undefined && { title: parsed.title }),
        ...(parsed.content !== undefined && { content: parsed.content }),
        ...(parsed.icon !== undefined && { icon: parsed.icon }),
        ...(parsed.tags !== undefined && { tags: [...new Set(parsed.tags)] }),
        ...(parsed.favorite !== undefined && { favorite: parsed.favorite }),
        ...(parsed.archived !== undefined && { archived: parsed.archived }),
        ...(parsed.linkedQuestionIds !== undefined && { linkedQuestionIds: [...new Set(parsed.linkedQuestionIds)] }),
        ...(parsed.splitQuestionId !== undefined && { splitQuestionId: parsed.splitQuestionId }),
        ...(parsed.sectionId !== undefined && { sectionId: parsed.sectionId }),
        ...(parsed.order !== undefined && { order: parsed.order }),
        revision: { increment: 1 },
      },
    });
    if (result.count === 0) return null;
    if ((contentChanged || titleChanged) && snapshotDue) {
      await tx.pageSnapshot.create({
        data: {
          pageId: access.page.id,
          createdById: user.id,
          title: access.page.title,
          content: access.page.content,
          revision: access.page.revision,
          reason: parsed.snapshotReason ?? (parsed.createSnapshot ? 'manual' : 'autosave'),
        },
      });
    }
    return tx.page.findUnique({ where: { id: access.page.id } });
  });

  if (!updated) {
    const serverPage = await prisma.page.findUnique({ where: { id: access.page.id } });
    return NextResponse.json({ error: 'Page changed while saving', conflict: true, serverPage }, { status: 409 });
  }
  await syncPageToCloud({ ...updated, ownerId: access.ownerId });
  await refreshRagIndex(`page:${updated.id}`, () => indexPage(updated.id));
  // Notify other editors on this page that the content was saved, so their
  // SSE listener triggers an auto-refresh of the editor.
  if (contentChanged || titleChanged) {
    await notifyRevision(updated.id, {
      pageId: updated.id,
      revision: updated.revision,
      savedBy: user.id,
    }).catch(() => {
      // NOTIFY is best-effort; clients will pick up the change on next reconnect.
    });
  }
  return NextResponse.json({ ...updated, accessRole: access.role });
}

export async function PUT(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let parsed: z.infer<typeof ReorderPages>;
  try {
    parsed = ReorderPages.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid order' }, { status: 400 });
  }
  const section = await prisma.section.findFirst({
    where: { id: parsed.sectionId, notebook: { userId: user.id } },
    include: { pages: { select: { id: true } } },
  });
  if (!section) return NextResponse.json({ error: 'Section not found' }, { status: 404 });
  const existingIds = new Set(section.pages.map((page) => page.id));
  if (parsed.orderedPageIds.length !== existingIds.size || parsed.orderedPageIds.some((id) => !existingIds.has(id))) {
    return NextResponse.json({ error: 'Order must contain every page in the section' }, { status: 400 });
  }
  await prisma.$transaction(parsed.orderedPageIds.map((id, order) => prisma.page.update({ where: { id }, data: { order } })));
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const pageId = new URL(req.url).searchParams.get('pageId');
  if (!pageId) return NextResponse.json({ error: 'pageId is required' }, { status: 400 });
  const access = await getPageAccess(pageId, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  if (access.role !== 'owner') return NextResponse.json({ error: 'Only the owner can delete a page' }, { status: 403 });
  await prisma.$transaction([
    prisma.page.delete({ where: { id: pageId } }),
    prisma.cloudDocument.updateMany({ where: { ownerId: access.ownerId, clientId: `page:${pageId}` }, data: { deletedAt: new Date() } }),
  ]);
  await refreshRagIndex(`page:${pageId}`, () => indexPage(pageId));
  return NextResponse.json({ ok: true });
}
