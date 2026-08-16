import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getPageAccess } from '@/lib/page-access';
import { indexPage, refreshRagIndex } from '@/lib/rag-index';

export const dynamic = 'force-dynamic';

const InviteCollaborator = z.object({
  email: z.string().trim().email(),
  role: z.enum(['editor', 'viewer']),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const access = await getPageAccess(id, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });

  const collaborators = await prisma.pageCollaborator.findMany({
    where: { pageId: id },
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return NextResponse.json({
    owner: access.page.section.notebook.user,
    collaborators,
    accessRole: access.role,
  });
}

export async function POST(req: Request, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const access = await getPageAccess(id, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  if (access.role !== 'owner') return NextResponse.json({ error: 'Only the owner can share this page' }, { status: 403 });

  let body: z.infer<typeof InviteCollaborator>;
  try {
    body = InviteCollaborator.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid invitation' }, { status: 400 });
  }

  const invitedUser = await prisma.user.findUnique({ where: { email: body.email.toLowerCase() }, select: { id: true, name: true, email: true, image: true } });
  if (!invitedUser) return NextResponse.json({ error: 'No account uses that email address' }, { status: 404 });
  if (invitedUser.id === user.id) return NextResponse.json({ error: 'You already own this page' }, { status: 400 });

  const collaborator = await prisma.pageCollaborator.upsert({
    where: { pageId_userId: { pageId: id, userId: invitedUser.id } },
    create: { pageId: id, userId: invitedUser.id, role: body.role },
    update: { role: body.role },
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
  });
  await refreshRagIndex(`page:${id}`, () => indexPage(id));
  return NextResponse.json({ collaborator }, { status: 201 });
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const access = await getPageAccess(id, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });

  const requestedUserId = new URL(req.url).searchParams.get('userId') ?? user.id;
  if (access.role !== 'owner' && requestedUserId !== user.id) {
    return NextResponse.json({ error: 'You can only remove yourself' }, { status: 403 });
  }
  if (requestedUserId === access.ownerId) return NextResponse.json({ error: 'The owner cannot be removed' }, { status: 400 });

  const result = await prisma.pageCollaborator.deleteMany({ where: { pageId: id, userId: requestedUserId } });
  if (result.count === 0) return NextResponse.json({ error: 'Collaborator not found' }, { status: 404 });
  await refreshRagIndex(`page:${id}`, () => indexPage(id));
  return NextResponse.json({ ok: true });
}
