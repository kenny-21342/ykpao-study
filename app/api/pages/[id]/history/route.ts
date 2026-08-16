import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canEditPage, getPageAccess, syncPageToCloud } from '@/lib/page-access';

export const dynamic = 'force-dynamic';

const RestoreSnapshot = z.object({
  snapshotId: z.string().min(1),
  baseRevision: z.number().int().positive(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const access = await getPageAccess(id, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });

  const snapshots = await prisma.pageSnapshot.findMany({
    where: { pageId: id },
    include: { createdBy: { select: { id: true, name: true, email: true, image: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return NextResponse.json({ snapshots });
}

export async function POST(req: Request, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const access = await getPageAccess(id, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  if (!canEditPage(access.role)) return NextResponse.json({ error: 'Read-only page' }, { status: 403 });

  let body: z.infer<typeof RestoreSnapshot>;
  try {
    body = RestoreSnapshot.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid restore request' }, { status: 400 });
  }
  if (body.baseRevision !== access.page.revision) {
    return NextResponse.json({ error: 'Page has a newer revision', conflict: true, serverPage: access.page }, { status: 409 });
  }

  const snapshot = await prisma.pageSnapshot.findFirst({ where: { id: body.snapshotId, pageId: id } });
  if (!snapshot) return NextResponse.json({ error: 'Version not found' }, { status: 404 });

  const restored = await prisma.$transaction(async (tx) => {
    const updated = await tx.page.updateMany({
      where: { id, revision: body.baseRevision },
      data: { title: snapshot.title, content: snapshot.content, revision: { increment: 1 } },
    });
    if (updated.count === 0) return null;
    await tx.pageSnapshot.create({
      data: {
        pageId: id,
        createdById: user.id,
        title: access.page.title,
        content: access.page.content,
        revision: access.page.revision,
        reason: 'restore',
      },
    });
    return tx.page.findUnique({ where: { id } });
  });

  if (!restored) {
    const serverPage = await prisma.page.findUnique({ where: { id } });
    return NextResponse.json({ error: 'Page changed while restoring', conflict: true, serverPage }, { status: 409 });
  }
  await syncPageToCloud({ ...restored, ownerId: access.ownerId });
  return NextResponse.json({ ...restored, accessRole: access.role });
}
