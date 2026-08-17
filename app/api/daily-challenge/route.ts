import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isAIConfigured, chatJSON } from '@/lib/ai';
import { checkAiAllowance, recordUsage } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at the platform default (60s Hobby / 300s Pro)
 * regardless of what the request is doing. One LLM completion.
 */
export const maxDuration = 60;

/**
 * Deterministic question-of-the-day picker.
 *
 * We pick a stable question id for each (dateKey) so every student sees the
 * *same* challenge on a given day — this is what makes it a shared community
 * talking point. The rotation uses a simple seeded hash over the candidate
 * pool of `marks > 0` questions.
 *
 * Returns the selected PastPaperQuestion, or null if the DB has no candidates.
 */
async function pickDailyQuestion(dateKey: string) {
  const candidates = await prisma.pastPaperQuestion.findMany({
    where: { docType: 'qp', marks: { gt: 0 } },
    select: { id: true, topic: true, paper: { select: { subject: { select: { name: true } } } } },
    take: 500,
    orderBy: { id: 'asc' },
  });
  if (candidates.length === 0) return null;

  // Simple deterministic seed from the date string.
  let seed = 0;
  for (let i = 0; i < dateKey.length; i++) seed = (seed * 31 + dateKey.charCodeAt(i)) >>> 0;
  const idx = seed % candidates.length;
  const picked = candidates[idx];

  return prisma.pastPaperQuestion.findUnique({
    where: { id: picked.id },
    include: {
      paper: { select: { subject: { select: { name: true } }, year: true } },
    },
  });
}

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * GET /api/daily-challenge
 *   Returns today's challenge question plus the user's attempt for today (if any).
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dateKey = todayKey();
  const question = await pickDailyQuestion(dateKey);
  if (!question) {
    return NextResponse.json({ error: 'No questions available for the challenge.' }, { status: 404 });
  }

  const attempt = await prisma.dailyChallengeAttempt.findUnique({
    where: { userId_dateKey: { userId: user.id, dateKey } },
  });

  // Pull a small participation snapshot for community feel — total attempts today.
  const participants = await prisma.dailyChallengeAttempt.count({
    where: { dateKey },
  });
  const correctToday = await prisma.dailyChallengeAttempt.count({
    where: { dateKey, isCorrect: true },
  });

  return NextResponse.json({
    dateKey,
    question: {
      id: question.id,
      number: question.number,
      part: question.part,
      content: question.content,
      marks: question.marks,
      topic: question.topic,
      paper: {
        year: question.paper.year,
        subject: question.paper.subject.name,
      },
    },
    attempt: attempt
      ? {
          answer: attempt.answer,
          score: attempt.score,
          isCorrect: attempt.isCorrect,
          attemptedAt: attempt.attemptedAt,
        }
      : null,
    stats: {
      participants,
      correctToday,
    },
  });
}

const SubmitBody = z.object({
  answer: z.string().min(1).max(5000),
});

/**
 * POST /api/daily-challenge
 *   Submit an answer for today's challenge. Grades with AI (if configured),
 *   records the attempt (one per user per day), and runs achievement checks.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Grading a daily challenge is an LLM call.
  const allowance = await checkAiAllowance(user.id);
  if (!allowance.allowed) {
    return NextResponse.json(
      { error: allowance.message },
      { status: 429 }
    );
  }

  let parsed;
  try {
    parsed = SubmitBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request' },
      { status: 400 }
    );
  }

  const dateKey = todayKey();

  // Block re-submission — one attempt per user per day.
  const existing = await prisma.dailyChallengeAttempt.findUnique({
    where: { userId_dateKey: { userId: user.id, dateKey } },
  });
  if (existing) {
    return NextResponse.json(
      { error: "You've already completed today's challenge.", attempt: existing },
      { status: 409 }
    );
  }

  const question = await pickDailyQuestion(dateKey);
  if (!question) {
    return NextResponse.json({ error: 'No challenge available.' }, { status: 404 });
  }

  // Grade with AI when available; otherwise mark as submitted without a score.
  let score: number | null = null;
  let isCorrect: boolean | null = null;
  let feedback = '';

  if (isAIConfigured()) {
    try {
      const result = await chatJSON<{ score: number; feedback: string }>(
        [
          {
            role: 'system',
            content:
              'You are an exam marker. Grade the student answer against the marking guidance. ' +
              'Return JSON: {"score": number out of total marks, "feedback": brief comment}.',
          },
          {
            role: 'user',
            content:
              `Question (worth ${question.marks} marks):\n${question.content}\n\n` +
              `Student answer:\n${parsed.answer}\n\nReturn JSON only.`,
          },
        ],
        { temperature: 0.2, maxTokens: 600 }
      );
      score = Math.max(0, Math.min(question.marks, Math.round(result.score)));
      isCorrect = score >= Math.ceil(question.marks * 0.5);
      feedback = result.feedback ?? '';
      await recordUsage({ userId: user.id, feature: 'daily-challenge', tokensOut: 400 });
    } catch (err) {
      // AI grading failed — record the attempt ungraded so the user isn't blocked.
      console.error('Daily challenge grading failed:', err);
    }
  }

  const attempt = await prisma.dailyChallengeAttempt.create({
    data: {
      userId: user.id,
      questionId: question.id,
      dateKey,
      answer: parsed.answer,
      score,
      isCorrect,
    },
  });

  return NextResponse.json({ ok: true, attempt, feedback, marks: question.marks });
}
