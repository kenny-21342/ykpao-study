import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getPageAccess } from '@/lib/page-access';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

async function listPresence(pageId: string) {
  const activeAfter = new Date(Date.now() - 2 * 60_000);
  return prisma.pagePresence.findMany({
    where: { pageId, lastSeenAt: { gte: activeAfter } },
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
    orderBy: { lastSeenAt: 'desc' },
  });
}

export async function GET(_req: Request, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const access = await getPageAccess(id, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  return NextResponse.json({ presence: await listPresence(id) });
}

export async function POST(_req: Request, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const access = await getPageAccess(id, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  await prisma.pagePresence.upsert({
    where: { pageId_userId: { pageId: id, userId: user.id } },
    create: { pageId: id, userId: user.id },
    update: { lastSeenAt: new Date() },
  });
  return NextResponse.json({ presence: await listPresence(id) });
}
