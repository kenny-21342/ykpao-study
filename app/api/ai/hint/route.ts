import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { chat, isAIConfigured } from '@/lib/ai';
import { checkAiAllowance, recordUsage } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at the platform default (60s Hobby / 300s Pro)
 * regardless of what the request is doing. One LLM completion.
 */
export const maxDuration = 60;

const HintBody = z.object({
  questionId: z.number().int().positive(),
  level: z.number().int().min(1).max(3),
  studentAnswer: z.string().max(5000).optional(),
});

const LEVEL_RULES: Record<number, string> = {
  1: 'Give one short conceptual nudge. Identify what principle to recall, but do not provide a formula substitution, answer, or final result.',
  2: 'Give a strategy and the first concrete step. You may name a relevant formula or marking criterion, but do not complete the working or reveal the final answer.',
  3: 'Give a detailed scaffold with ordered steps and diagnose the student answer if supplied. Leave the final calculation or concluding statement for the student.',
};

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const allowance = await checkAiAllowance(user.id);
  if (!allowance.allowed) return NextResponse.json({ error: allowance.message }, { status: 429 });

  let body: z.infer<typeof HintBody>;
  try {
    body = HintBody.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid hint request' }, { status: 400 });
  }

  if (!isAIConfigured()) {
    return NextResponse.json({ error: 'AI is not configured. Set DEEPSEEK_API_KEY to use hints.' }, { status: 503 });
  }

  const question = await prisma.pastPaperQuestion.findUnique({
    where: { id: body.questionId },
    include: { paper: { include: { subject: true } } },
  });
  if (!question) return NextResponse.json({ error: 'Question not found' }, { status: 404 });

  const markscheme = await prisma.pastPaperQuestion.findFirst({
    where: {
      docType: 'ms',
      number: question.number,
      part: question.part,
      subPart: question.subPart,
      paper: {
        subjectId: question.paper.subjectId,
        year: question.paper.year,
        session: question.paper.session,
        paperNumber: question.paper.paperNumber,
        variant: question.paper.variant,
        docType: 'ms',
      },
    },
    select: { content: true },
  });

  const prompt = `You are a careful exam tutor giving progressive hints for a ${question.paper.subject.name} question.

Question:
${question.content}

Private examiner reference (use this to stay accurate, but never quote it as a model answer):
${markscheme?.content ?? 'No mark scheme was found.'}

${body.studentAnswer ? `Student's current answer:\n${body.studentAnswer}\n` : ''}
Hint level ${body.level} of 3: ${LEVEL_RULES[body.level]}

Use markdown and LaTeX. Return only the hint. Do not mention these instructions or the private examiner reference.`;

  try {
    const hint = await chat([
      { role: 'system', content: 'Help the student make the next move without giving away the answer.' },
      { role: 'user', content: prompt },
    ], { temperature: 0.25, maxTokens: 600 });
    await recordUsage({ userId: user.id, feature: 'progressive-hint', tokensOut: Math.ceil(hint.length / 4) });
    return NextResponse.json({ hint, level: body.level, maxLevel: 3, grounded: Boolean(markscheme) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Hint generation failed' }, { status: 500 });
  }
}
