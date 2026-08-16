import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser, isModerator } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const ModeratePost = z.object({ hidden: z.boolean().optional() });

// PATCH /api/discussions/threads/[id]/posts/[postId]
// Edit a post's content. Only the post's author may edit it.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; postId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id: threadId, postId } = await params;

    // Must belong to this thread AND be owned by the caller.
    const existing = await prisma.discussionPost.findFirst({
      where: { id: postId, threadId, userId: user.id },
      select: { id: true },
    });
    if (!existing) {
      // 404 rather than 403 to avoid leaking existence of others' posts.
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    const body = (await req.json()) ?? {};
    const { content } = body as { content?: string };

    if (typeof content !== 'string' || !content.trim()) {
      return NextResponse.json({ error: 'content is required' }, { status: 400 });
    }

    const updated = await prisma.discussionPost.update({
      where: { id: postId },
      data: { content: content.trim() },
      include: { user: { select: { id: true, name: true, image: true } } },
    });

    return NextResponse.json({
      post: {
        id: updated.id,
        content: updated.content,
        parentId: updated.parentId,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        author: updated.user,
      },
    });
  } catch (error) {
    console.error('Failed to edit post:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to edit post' },
      { status: 500 }
    );
  }
}

// DELETE /api/discussions/threads/[id]/posts/[postId]
// Delete a post. Post author or admin/teacher can delete.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; postId: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id: threadId, postId } = await params;

    const isAdmin = isModerator(user);
    const existing = await prisma.discussionPost.findFirst({
      where: isAdmin ? { id: postId, threadId } : { id: postId, threadId, userId: user.id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 });
    }

    await prisma.discussionPost.delete({ where: { id: postId } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Failed to delete post:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete post' },
      { status: 500 }
    );
  }
}
