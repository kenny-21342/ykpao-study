import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { conversationTitle } from '@/lib/ai-conversations';
import { getLearnerContext, LearnerContextError } from '@/lib/learner-context';

export const dynamic = 'force-dynamic';

const CreateConversation = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  mode: z.enum(['explain', 'hint', 'socratic', 'check', 'worked-example']).default('explain'),
  courseId: z.string().min(1).nullable().optional(),
});

const UpdateConversation = z.object({
  conversationId: z.string().min(1),
  title: z.string().trim().min(1).max(120).optional(),
  mode: z.enum(['explain', 'hint', 'socratic', 'check', 'worked-example']).optional(),
  archived: z.boolean().optional(),
  courseId: z.string().min(1).nullable().optional(),
});

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const conversationId = new URL(req.url).searchParams.get('conversationId');

  if (conversationId) {
    const conversation = await prisma.aIConversation.findFirst({
      where: { id: conversationId, userId: user.id, archived: false },
    });
    if (!conversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    const messages = await prisma.aIMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return NextResponse.json({ conversation, messages: messages.reverse() });
  }

  const conversations = await prisma.aIConversation.findMany({
    where: { userId: user.id, archived: false },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: {
      messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { content: true, role: true } },
      _count: { select: { messages: true } },
    },
  });
  return NextResponse.json({ conversations });
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: z.infer<typeof CreateConversation>;
  try {
    body = CreateConversation.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid conversation' }, { status: 400 });
  }
  try {
    if (body.courseId) await getLearnerContext({ userId: user.id, explicitCourseId: body.courseId });
    const conversation = await prisma.aIConversation.create({
      data: { userId: user.id, courseId: body.courseId ?? null, title: conversationTitle(body.title || 'New conversation'), mode: body.mode },
    });
    return NextResponse.json({ conversation }, { status: 201 });
  } catch (error) {
    if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: z.infer<typeof UpdateConversation>;
  try {
    body = UpdateConversation.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid conversation update' }, { status: 400 });
  }
  const existing = await prisma.aIConversation.findFirst({ where: { id: body.conversationId, userId: user.id } });
  if (!existing) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  try {
    if (body.courseId) await getLearnerContext({ userId: user.id, explicitCourseId: body.courseId });
  } catch (error) {
    if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  const conversation = await prisma.aIConversation.update({
    where: { id: existing.id },
    data: {
      ...(body.title !== undefined && { title: body.title }),
      ...(body.mode !== undefined && { mode: body.mode }),
      ...(body.archived !== undefined && { archived: body.archived }),
      ...(body.courseId !== undefined && { courseId: body.courseId }),
    },
  });
  return NextResponse.json({ conversation });
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const conversationId = new URL(req.url).searchParams.get('conversationId');
  if (!conversationId) return NextResponse.json({ error: 'conversationId is required' }, { status: 400 });
  const result = await prisma.aIConversation.deleteMany({ where: { id: conversationId, userId: user.id } });
  if (result.count === 0) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
