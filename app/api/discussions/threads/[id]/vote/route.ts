import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const VoteBody = z.object({
  direction: z.union([z.literal(1), z.literal(-1), z.literal(0)]), // 0 = retract
});

/**
 * POST /api/discussions/threads/[id]/vote
 * Body: { direction: 1 | -1 | 0 }
 *
 * 1 = upvote, -1 = downvote, 0 = retract existing vote.
 * One vote per user per thread. Updates the denormalized upvotes/downvotes
 * counters atomically so list pages can render scores without aggregation.
 */
export async function POST(req: Request, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id: threadId } = await params;

  let parsed: z.infer<typeof VoteBody>;
  try {
    parsed = VoteBody.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid vote' }, { status: 400 });
  }

  const existing = await prisma.discussionVote.findUnique({
    where: { userId_threadId: { userId: user.id, threadId } },
  });

  await prisma.$transaction(async (tx) => {
    if (existing) {
      // Remove old vote's effect on counters.
      if (existing.direction === 1) {
        await tx.discussionThread.update({ where: { id: threadId }, data: { upvotes: { decrement: 1 } } });
      } else {
        await tx.discussionThread.update({ where: { id: threadId }, data: { downvotes: { decrement: 1 } } });
      }
      if (parsed.direction === 0) {
        await tx.discussionVote.delete({ where: { id: existing.id } });
        return;
      }
    }

    if (parsed.direction === 0) return; // nothing to retract

    if (existing) {
      await tx.discussionVote.update({ where: { id: existing.id }, data: { direction: parsed.direction } });
    } else {
      await tx.discussionVote.create({ data: { threadId, userId: user.id, direction: parsed.direction } });
    }

    if (parsed.direction === 1) {
      await tx.discussionThread.update({ where: { id: threadId }, data: { upvotes: { increment: 1 } } });
    } else {
      await tx.discussionThread.update({ where: { id: threadId }, data: { downvotes: { increment: 1 } } });
    }
  });

  const thread = await prisma.discussionThread.findUnique({
    where: { id: threadId },
    select: { upvotes: true, downvotes: true },
  });
  return NextResponse.json({ upvotes: thread?.upvotes ?? 0, downvotes: thread?.downvotes ?? 0 });
}
