import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { chat } from '@/lib/ai';
import { forInteractive, requireTextAi, type TextCredential } from '@/lib/ai-credentials';
import { checkAiAllowance, recordUsage } from '@/lib/rate-limit';
import { reportError } from '@/lib/error-reporting';
import { buildHintPrompt, MAX_PREVIOUS_HINTS, MAX_PREVIOUS_HINT_CHARS } from '@/lib/hint-prompt';

export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at this ceiling regardless of what the request
 * is doing. This project is on Pro, where the ceiling is 300s; 60 was a
 * Hobby-era number and was never revisited. One LLM completion.
 */
export const maxDuration = 120;

/**
 * Exactly one of `questionId` and `bankQuestionId` identifies the question.
 *
 * They address different tables. `questionId` is a transcribed text-bank row;
 * `bankQuestionId` is a crop-first bank row, which students actually browse
 * and whose `bodyMd` is empty unless that subject's transcription has been
 * paid for. A hint has to read the question, so a crop-only row cannot be
 * hinted at all -- the caller hides the control, and this refuses clearly if
 * one is asked for anyway.
 */
const HintBody = z
  .object({
    questionId: z.number().int().positive().optional(),
    bankQuestionId: z.number().int().positive().optional(),
    level: z.number().int().min(1).max(3),
    studentAnswer: z.string().max(5000).optional(),
    // The hints this student has already been shown for this question. Without
    // them every request is answered as the first, and Hint 2 repeats Hint 1.
    previousHints: z.array(z.string().max(MAX_PREVIOUS_HINT_CHARS)).max(MAX_PREVIOUS_HINTS).optional(),
  })
  .refine(
    (body) => Boolean(body.questionId) !== Boolean(body.bankQuestionId),
    { message: 'Provide exactly one of questionId or bankQuestionId' },
  );

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const access = await requireTextAi(user.id);
  if (!access.ok) {
    return NextResponse.json(
      { error: access.error, reason: access.reason, aiDisabled: true },
      { status: access.status },
    );
  }
  const allowance = await checkAiAllowance(user.id, { source: access.source });
  if (!allowance.allowed) return NextResponse.json({ error: allowance.message }, { status: 429 });

  let body: z.infer<typeof HintBody>;
  try {
    body = HintBody.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid hint request' }, { status: 400 });
  }

  if (body.bankQuestionId) {
    return hintForBankQuestion(body.bankQuestionId, body, user.id, access);
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

  const prompt = buildHintPrompt({
    subject: question.paper.subject.name,
    question: question.content,
    reference: markscheme?.content,
    studentAnswer: body.studentAnswer,
    level: body.level,
    previousHints: body.previousHints,
  });

  try {
    const usage: { current: { promptTokens: number; completionTokens: number } | null } = { current: null };
    const hint = await chat([
      { role: 'system', content: 'Help the student make the next move without giving away the answer.' },
      { role: 'user', content: prompt },
    ], { credential: forInteractive(access.credential), temperature: 0.25, maxTokens: 600, onUsage: (u) => { usage.current = u; } });
    await recordUsage({
      userId: user.id,
      feature: 'progressive-hint',
      tokensIn: usage.current?.promptTokens ?? Math.ceil(prompt.length / 4),
      tokensOut: usage.current?.completionTokens ?? Math.ceil(hint.length / 4),
      model: access.credential.model,
    });
    return NextResponse.json({ hint, level: body.level, maxLevel: 3, grounded: Boolean(markscheme) });
  } catch (error) {
    await recordUsage({ userId: user.id, feature: 'progressive-hint:error', model: access.credential.model });
    await reportError(error, { routePath: '/api/ai/hint', source: 'route' });
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Hint generation failed' }, { status: 500 });
  }
}

/**
 * A hint for a crop-first bank question.
 *
 * The bank is images: `bodyMd` is empty for every question a crop-only run
 * produced, and transcription is a separate paid pass done subject by subject.
 * Without that text there is nothing to send a model, so this refuses rather
 * than prompting it with an empty question and returning a confident guess
 * about a question it was never shown.
 *
 * The mark scheme has the same problem and is treated the same way: used when
 * it has text, and simply absent otherwise, which the prompt already handles.
 */
async function hintForBankQuestion(
  bankQuestionId: number,
  body: { level: number; studentAnswer?: string; previousHints?: string[] },
  userId: string,
  // Typed as the real credential rather than `{ model: string }`: the loose
  // shape forced an `as never` at the call below, which would have hidden a
  // genuine mismatch just as effectively as it hid this one.
  access: { credential: TextCredential } & Record<string, unknown>,
) {
  const question = await prisma.bankQuestion.findFirst({
    where: { id: bankQuestionId, status: 'published' },
    include: {
      markScheme: { select: { answerMd: true, status: true } },
      paper: { include: { subject: true } },
    },
  });
  if (!question) return NextResponse.json({ error: 'Question not found' }, { status: 404 });

  const questionText = question.bodyMd.trim();
  if (!questionText) {
    return NextResponse.json(
      {
        error:
          'This question has not been transcribed yet, so a hint cannot be generated for it.',
        needsTranscription: true,
      },
      { status: 409 },
    );
  }

  const markSchemeText =
    question.markScheme?.status === 'published' ? question.markScheme.answerMd?.trim() : '';

  const prompt = buildHintPrompt({
    subject: question.paper.subject.name,
    question: questionText,
    reference: markSchemeText,
    studentAnswer: body.studentAnswer,
    level: body.level,
    previousHints: body.previousHints,
  });

  try {
    const usage: { current: { promptTokens: number; completionTokens: number } | null } = { current: null };
    const hint = await chat(
      [
        { role: 'system', content: 'Help the student make the next move without giving away the answer.' },
        { role: 'user', content: prompt },
      ],
      { credential: forInteractive(access.credential), temperature: 0.25, maxTokens: 600, onUsage: (u) => { usage.current = u; } },
    );
    await recordUsage({
      userId,
      feature: 'progressive-hint',
      tokensIn: usage.current?.promptTokens ?? Math.ceil(prompt.length / 4),
      tokensOut: usage.current?.completionTokens ?? Math.ceil(hint.length / 4),
      model: access.credential.model,
    });
    return NextResponse.json({
      hint,
      level: body.level,
      maxLevel: 3,
      grounded: Boolean(markSchemeText),
    });
  } catch (error) {
    await recordUsage({ userId, feature: 'progressive-hint:error', model: access.credential.model });
    await reportError(error, { routePath: '/api/ai/hint', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Hint generation failed' },
      { status: 500 },
    );
  }
}
