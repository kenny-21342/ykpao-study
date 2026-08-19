import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const Body = z.object({
  questionId: z.string().min(1).max(100),
  answer: z.string().min(1).max(10000),
  timeSpent: z.number().int().nonnegative().max(60 * 60 * 24).optional(),
});

/**
 * POST /api/attempts — record an attempt on a custom-bank Question (legacy).
 * The primary past-paper attempt table is PastPaperAttempt (used by /api/practice);
 * this endpoint targets the Question model.
 */
export async function POST(req: Request) {
  // getSessionUser() rather than getServerSession(): it is the chokepoint that
  // enforces bans and credential-fingerprint revocation, so reading the session
  // directly would let a device holding a reset-away password keep writing
  // attempts to the account.
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request' },
      { status: 400 }
    );
  }

  // Verify the question exists before recording the attempt.
  const q = await prisma.question.findUnique({
    where: { id: parsed.questionId },
    select: { id: true },
  });
  if (!q) {
    return NextResponse.json({ error: 'Question not found' }, { status: 404 });
  }

  const attempt = await prisma.questionAttempt.create({
    data: {
      userId: user.id,
      questionId: parsed.questionId,
      answer: parsed.answer,
      timeSpent: parsed.timeSpent ?? 0,
      attemptedAt: new Date(),
    },
  });

  return NextResponse.json(attempt, { status: 201 });
}
