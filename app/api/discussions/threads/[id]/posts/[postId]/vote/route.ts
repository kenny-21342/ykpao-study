import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string; postId: string }> };

const VoteBody = z.object({
  direction: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
});

/** POST /api/discussions/threads/[id]/posts/[postId]/vote */
export async function POST(req: Request, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { postId } = await params;

  let parsed: z.infer<typeof VoteBody>;
  try {
    parsed = VoteBody.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid vote' }, { status: 400 });
  }

  const existing = await prisma.discussionVote.findUnique({
    where: { userId_postId: { userId: user.id, postId } },
  });

  await prisma.$transaction(async (tx) => {
    if (existing) {
      if (existing.direction === 1) {
        await tx.discussionPost.update({ where: { id: postId }, data: { upvotes: { decrement: 1 } } });
      } else {
        await tx.discussionPost.update({ where: { id: postId }, data: { downvotes: { decrement: 1 } } });
      }
      if (parsed.direction === 0) {
        await tx.discussionVote.delete({ where: { id: existing.id } });
        return;
      }
    }
    if (parsed.direction === 0) return;
    if (existing) {
      await tx.discussionVote.update({ where: { id: existing.id }, data: { direction: parsed.direction } });
    } else {
      await tx.discussionVote.create({ data: { postId, userId: user.id, direction: parsed.direction } });
    }
    if (parsed.direction === 1) {
      await tx.discussionPost.update({ where: { id: postId }, data: { upvotes: { increment: 1 } } });
    } else {
      await tx.discussionPost.update({ where: { id: postId }, data: { downvotes: { increment: 1 } } });
    }
  });

  const post = await prisma.discussionPost.findUnique({
    where: { id: postId },
    select: { upvotes: true, downvotes: true },
  });
  return NextResponse.json({ upvotes: post?.upvotes ?? 0, downvotes: post?.downvotes ?? 0 });
}
