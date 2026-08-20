import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { chatJSON, SYSTEM_PROMPTS } from '@/lib/ai';
import { requireTextAi } from '@/lib/ai-credentials';
import { checkAiAllowance, recordUsage } from '@/lib/rate-limit';
import type { GradeResult } from '@/types/ai';

export const dynamic = 'force-dynamic';

/**
 * Grading is one LLM completion, which routinely runs well past the platform's
 * default function limit. Without this declaration the invocation is killed
 * after a few seconds and the student sees a gateway error instead of a mark —
 * the same 60s ceiling every other AI route declares.
 */
export const maxDuration = 60;

const Body = z.object({
  question: z.string().min(1).max(8000),
  markscheme: z.string().max(8000).optional(),
  answer: z.string().min(1).max(8000),
  marks: z.number().int().positive().max(100).optional(),
});

/** POST /api/ai/check-answer — grade a student answer with DeepSeek. */
export async function POST(req: Request) {
  // getSessionUser() rather than getServerSession(): it is the chokepoint that
  // enforces bans and credential-fingerprint revocation. That matters more here
  // than on a read-only route — this one spends money per call.
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const access = await requireTextAi(user.id);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error, reason: access.reason, aiDisabled: true },
      { status: access.status }
    );
  }

  const allowance = await checkAiAllowance(user.id, { source: access.source });
  if (!allowance.allowed) {
    return NextResponse.json(
      { error: allowance.message },
      { status: 429 }
    );
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

  const { question, markscheme, answer, marks } = parsed;

  const userContent = `Grade the student's answer against the markscheme.

Question:
${question}

${markscheme ? `Markscheme:\n${markscheme}\n\n` : ''}${marks ? `Total marks: ${marks}\n\n` : ''}Student answer:
${answer}`;

  try {
    const result = await chatJSON<GradeResult>(
      [
        { role: 'system', content: SYSTEM_PROMPTS.grader },
        { role: 'user', content: userContent },
      ],
      { credential: access.credential, temperature: 0.2, maxTokens: 1500 }
    );

    const max = marks ?? result.maxScore ?? 1;
    const clampedScore = Math.max(0, Math.min(max, Number(result.score) || 0));

    await recordUsage({
      userId: user.id,
      feature: 'practice-grade',
      tokensOut: 800, // rough estimate
      model: access.credential.model,
    });

    return NextResponse.json({
      score: clampedScore,
      maxScore: max,
      isCorrect: result.isCorrect ?? clampedScore >= max,
      strengths: result.strengths ?? [],
      weaknesses: result.weaknesses ?? [],
      explanation: result.explanation ?? '',
      modelAnswer: result.modelAnswer ?? '',
      feedbackStatus: markscheme ? 'reference-grounded' : 'provisional',
      provisional: !markscheme,
    });
  } catch (error) {
    console.error('Error grading answer:', error);
    const status = (error as { status?: number })?.status ?? 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to grade answer' },
      { status }
    );
  }
}
