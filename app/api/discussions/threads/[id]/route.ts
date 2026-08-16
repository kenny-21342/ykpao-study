import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser, isModerator } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const ModerateBody = z.object({
  pinned: z.boolean().optional(),
  locked: z.boolean().optional(),
  hidden: z.boolean().optional(),
});

// GET /api/discussions/threads/[id] — fetch a thread + its posts (increments views)
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const canModerate = isModerator(user);

    const { id } = await params;

    const thread = await prisma.discussionThread.findUnique({
      where: { id },
      include: {
        subject: true,
        user: { select: { id: true, name: true, image: true } },
        posts: {
          // Moderator-hidden posts stay out of the payload entirely for
          // ordinary readers — previously they were returned in full and
          // merely flagged, so hiding was cosmetic.
          where: canModerate ? undefined : { hidden: false },
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { id: true, name: true, image: true } } },
        },
      },
    });

    if (!thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    if (thread.hidden && !canModerate) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    // Increment views (non-blocking)
    await prisma.discussionThread.update({
      where: { id },
      data: { views: { increment: 1 } },
    });

    return NextResponse.json({
      thread: {
        id: thread.id,
        title: thread.title,
        content: thread.content,
        pinned: thread.pinned,
        locked: thread.locked,
        hidden: thread.hidden,
        views: thread.views + 1,
        upvotes: thread.upvotes,
        downvotes: thread.downvotes,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        author: thread.user,
        category: thread.category,
        subject: thread.subject
          ? { id: thread.subject.id, code: thread.subject.code, name: thread.subject.name }
          : null,
        posts: thread.posts.map((p) => ({
          id: p.id,
          content: p.content,
          parentId: p.parentId,
          hidden: p.hidden,
          upvotes: p.upvotes,
          downvotes: p.downvotes,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          author: p.user,
        })),
      },
    });
  } catch (error) {
    console.error('Failed to fetch thread:', error);
    return NextResponse.json({ error: 'Failed to fetch thread' }, { status: 500 });
  }
}

// DELETE /api/discussions/threads/[id] — delete a thread (owner only)
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

    const isAdmin = isModerator(user);
    // Owner can always delete their own thread; admins/mods can delete any.
    const existing = await prisma.discussionThread.findFirst({
      where: isAdmin ? { id } : { id, userId: user.id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
    }

    await prisma.discussionThread.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Failed to delete thread:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete thread' },
      { status: 500 }
    );
  }
}

// PATCH /api/discussions/threads/[id] — moderate a thread (pin/lock/hide).
// Admin/teacher only.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (user.role !== 'admin' && user.role !== 'super_admin' && user.role !== 'teacher') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const { id } = await params;
    let parsed: z.infer<typeof ModerateBody>;
    try {
      parsed = ModerateBody.parse(await req.json());
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid request' }, { status: 400 });
    }

    const thread = await prisma.discussionThread.update({
      where: { id },
      data: {
        ...(parsed.pinned !== undefined && { pinned: parsed.pinned }),
        ...(parsed.locked !== undefined && { locked: parsed.locked }),
        ...(parsed.hidden !== undefined && { hidden: parsed.hidden }),
      },
      select: { id: true, pinned: true, locked: true, hidden: true },
    });
    return NextResponse.json({ thread });
  } catch (error) {
    console.error('Failed to moderate thread:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update thread' },
      { status: 500 }
    );
  }
}
