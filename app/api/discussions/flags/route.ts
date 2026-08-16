import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser, isModerator } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const FlagBody = z.object({
  threadId: z.string().optional(),
  postId: z.string().optional(),
  reason: z.string().trim().min(3).max(500),
}).refine((d) => d.threadId || d.postId, { message: 'threadId or postId is required' });

const ResolveBody = z.object({
  flagId: z.string(),
  status: z.enum(['dismissed', 'actioned']),
});

/**
 * GET /api/discussions/flags
 * Admin-only moderation queue. Returns open flags sorted by creation date.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isModerator(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const flags = await prisma.discussionFlag.findMany({
    where: { status: 'open' },
    include: {
      reporter: { select: { id: true, name: true, email: true } },
      thread: { select: { id: true, title: true, content: true, userId: true } },
      post: { select: { id: true, content: true, threadId: true, userId: true, thread: { select: { id: true, title: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return NextResponse.json({ flags });
}

/**
 * POST /api/discussions/flags
 * Any signed-in user can flag a thread or post. One flag per user per target.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let parsed: z.infer<typeof FlagBody>;
  try {
    parsed = FlagBody.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid flag' }, { status: 400 });
  }

  try {
    const flag = await prisma.discussionFlag.create({
      data: {
        threadId: parsed.threadId,
        postId: parsed.postId,
        reporterId: user.id,
        reason: parsed.reason,
      },
    });
    return NextResponse.json({ flag });
  } catch {
    // Most likely a unique constraint violation — user already flagged this.
    return NextResponse.json({ error: 'You have already flagged this content' }, { status: 409 });
  }
}

/**
 * PATCH /api/discussions/flags
 * Admin-only: resolve a flag (dismiss or action).
 */
export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!isModerator(user)) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  let parsed: z.infer<typeof ResolveBody>;
  try {
    parsed = ResolveBody.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid request' }, { status: 400 });
  }

  const flag = await prisma.discussionFlag.update({
    where: { id: parsed.flagId },
    data: {
      status: parsed.status,
      resolvedById: user.id,
      resolvedAt: new Date(),
    },
  });
  return NextResponse.json({ flag });
}
