import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canEditPage, getPageAccess } from '@/lib/page-access';

export const dynamic = 'force-dynamic';

const CreateComment = z.object({
  content: z.string().trim().min(1).max(4000),
  anchor: z.string().trim().max(500).nullable().optional(),
});

const UpdateComment = z.object({
  commentId: z.string().min(1),
  content: z.string().trim().min(1).max(4000).optional(),
  resolved: z.boolean().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

const commentInclude = { user: { select: { id: true, name: true, email: true, image: true } } } as const;

export async function GET(req: NextRequest, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const access = await getPageAccess(id, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  const includeResolved = new URL(req.url).searchParams.get('resolved') === 'true';
  const comments = await prisma.pageComment.findMany({
    where: { pageId: id, ...(!includeResolved && { resolved: false }) },
    include: commentInclude,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return NextResponse.json({ comments });
}

export async function POST(req: Request, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const access = await getPageAccess(id, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  let body: z.infer<typeof CreateComment>;
  try {
    body = CreateComment.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid comment' }, { status: 400 });
  }
  const comment = await prisma.pageComment.create({
    data: { pageId: id, userId: user.id, content: body.content, anchor: body.anchor || null },
    include: commentInclude,
  });
  return NextResponse.json({ comment }, { status: 201 });
}

export async function PATCH(req: Request, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const access = await getPageAccess(id, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  let body: z.infer<typeof UpdateComment>;
  try {
    body = UpdateComment.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid comment update' }, { status: 400 });
  }
  const comment = await prisma.pageComment.findFirst({ where: { id: body.commentId, pageId: id } });
  if (!comment) return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
  const isAuthor = comment.userId === user.id;
  if (body.content !== undefined && !isAuthor) return NextResponse.json({ error: 'Only the author can edit this comment' }, { status: 403 });
  if (body.resolved !== undefined && !isAuthor && !canEditPage(access.role)) {
    return NextResponse.json({ error: 'You cannot resolve this comment' }, { status: 403 });
  }
  const updated = await prisma.pageComment.update({
    where: { id: comment.id },
    data: { ...(body.content !== undefined && { content: body.content }), ...(body.resolved !== undefined && { resolved: body.resolved }) },
    include: commentInclude,
  });
  return NextResponse.json({ comment: updated });
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const access = await getPageAccess(id, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  const commentId = new URL(req.url).searchParams.get('commentId');
  if (!commentId) return NextResponse.json({ error: 'commentId is required' }, { status: 400 });
  const comment = await prisma.pageComment.findFirst({ where: { id: commentId, pageId: id } });
  if (!comment) return NextResponse.json({ error: 'Comment not found' }, { status: 404 });
  if (comment.userId !== user.id && access.role !== 'owner') return NextResponse.json({ error: 'You cannot delete this comment' }, { status: 403 });
  await prisma.pageComment.delete({ where: { id: comment.id } });
  return NextResponse.json({ ok: true });
}
