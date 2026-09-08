import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createNotifications } from '@/lib/notifications';
import { reportError } from '@/lib/error-reporting';
import { indexDiscussionThread, refreshRagIndex } from '@/lib/rag-index';

export const dynamic = 'force-dynamic';

// POST /api/discussions/threads/[id]/posts — add a reply to a thread
// Body: { content: string, parentId?: string }
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id: threadId } = await params;

    // Fetch thread + its author so we can notify the thread owner below.
    const thread = await prisma.discussionThread.findUnique({
      where: { id: threadId },
      select: { id: true, locked: true, userId: true, title: true },
    });
    if (!thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }
    if (thread.locked) {
      return NextResponse.json({ error: 'Thread is locked' }, { status: 403 });
    }

    const body = (await req.json()) ?? {};
    const { content, parentId } = body as { content?: string; parentId?: string };

    if (!content?.trim()) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 });
    }

    // If parentId given, ensure it belongs to the same thread + grab the
    // parent author's id so we can notify them on a nested reply.
    let parentAuthorId: string | null = null;
    if (parentId) {
      const parent = await prisma.discussionPost.findFirst({
        where: { id: parentId, threadId },
        select: { id: true, userId: true },
      });
      if (!parent) {
        return NextResponse.json({ error: 'Parent post not found' }, { status: 404 });
      }
      parentAuthorId = parent.userId;
    }

    const post = await prisma.discussionPost.create({
      data: {
        threadId,
        userId: user.id,
        parentId: parentId || null,
        content: content.trim(),
      },
      include: { user: { select: { id: true, name: true, image: true } } },
    });

    // Bump thread.updatedAt to surface activity
    await prisma.discussionThread.update({
      where: { id: threadId },
      data: { updatedAt: new Date() },
    });

    await refreshRagIndex(`discussion-thread:${threadId}`, () => indexDiscussionThread(threadId));

    // ---- Notifications ----
    // Notify (a) the thread author when someone replies, and (b) the parent
    // post author when it's a nested reply. Never notify the actor themselves.
    const actorName = user.name ?? 'Someone';
    const threadUrl = `/discussions?thread=${threadId}`;
    const recipients: Array<{
      userId: string;
      actorId: string;
      type: string;
      entityId?: string | null;
      entityUrl?: string | null;
      title: string;
      body?: string;
    }> = [];

    if (thread.userId !== user.id) {
      recipients.push({
        userId: thread.userId,
        actorId: user.id,
        type: parentId ? 'discussion_reply' : 'discussion_answer',
        entityId: threadId,
        entityUrl: threadUrl,
        title: parentId
          ? `${actorName} replied to a discussion you're in`
          : `${actorName} answered your thread`,
        body: thread.title,
      });
    }
    if (parentAuthorId && parentAuthorId !== user.id && parentAuthorId !== thread.userId) {
      recipients.push({
        userId: parentAuthorId,
        actorId: user.id,
        type: 'discussion_mention',
        entityId: threadId,
        entityUrl: threadUrl,
        title: `${actorName} replied to your post`,
        body: content.trim().slice(0, 140),
      });
    }
    if (recipients.length > 0) {
      await createNotifications(recipients);
    }

    return NextResponse.json({
      post: {
        id: post.id,
        content: post.content,
        parentId: post.parentId,
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
        author: post.user,
      },
    }, { status: 201 });
  } catch (error) {
    console.error('Failed to create post:', error);
    await reportError(error, { routePath: '/api/discussions/threads/[id]/posts', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create post' },
      { status: 500 }
    );
  }
}
