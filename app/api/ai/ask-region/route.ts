import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { askAboutImage } from '@/lib/vision';
import { requireVisionAi } from '@/lib/ai-credentials';
import { checkAiAllowance, recordUsage } from '@/lib/rate-limit';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * POST /api/ai/ask-region
 *
 * The student selects an area of a question or mark-scheme page and asks about
 * it -- the case for diagrams, graphs and circuits, which are hard to put into
 * words. The browser sends the cropped pixels as a data URL; nothing here reads
 * a bank asset by path, so this can only ever see what the student chose to send.
 */
const Body = z.object({
  // A crop of one page strip: a few hundred KB as PNG. 6M characters is generous
  // for a full-width crop and still bounds what one request can cost.
  image: z.string().regex(/^data:image\/(png|jpeg|webp);base64,/).max(6_000_000),
  question: z.string().trim().min(1).max(1000),
  bankQuestionId: z.number().int().positive().optional(),
  from: z.enum(['question', 'markscheme']).optional(),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(3000) }))
    .max(6)
    .optional(),
});

export async function POST(req: Request) {
  let attemptUserId: string | null = null;
  let attemptModel: string | undefined;
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    attemptUserId = user.id;

    const access = await requireVisionAi(user.id);
    if (!access.ok) {
      return NextResponse.json(
        { error: access.error, reason: access.reason, aiDisabled: true },
        { status: access.status },
      );
    }
    attemptModel = access.credential.model;

    const allowance = await checkAiAllowance(user.id, { source: access.source });
    if (!allowance.allowed) return NextResponse.json({ error: allowance.message }, { status: 429 });

    let body: z.infer<typeof Body>;
    try {
      body = Body.parse(await req.json());
    } catch {
      return NextResponse.json({ error: 'Select an area and type a question.' }, { status: 400 });
    }

    // Context for the model, never the answer: the subject and the question's own
    // text when it has been transcribed. The mark scheme is deliberately absent --
    // a student asking about a diagram in the question must not be handed the
    // answer by the side door.
    let context = '';
    if (body.bankQuestionId) {
      const question = await prisma.bankQuestion.findFirst({
        where: { id: body.bankQuestionId, status: 'published' },
        select: { bodyMd: true, paper: { select: { subject: { select: { name: true } } } } },
      });
      if (question) {
        const text = question.bodyMd.trim().slice(0, 1500);
        context = `Subject: ${question.paper.subject.name}.${body.from === 'markscheme' ? ' The selected area is from the mark scheme.' : ''}${text ? `\nThe question reads:\n${text}` : ''}`;
      }
    }

    const result = await askAboutImage(
      body.image,
      { question: body.question, context, history: body.history },
      access.credential,
    );
    if (!result?.content) {
      await recordUsage({ userId: user.id, feature: 'ask-region:error', model: access.credential.model });
      return NextResponse.json(
        { error: 'The AI could not read that area. Try selecting a little more around it.' },
        { status: 502 },
      );
    }

    await recordUsage({
      userId: user.id,
      feature: 'ask-region',
      tokensIn: result.usage?.tokensIn,
      tokensOut: result.usage?.tokensOut ?? Math.ceil(result.content.length / 4),
      model: access.credential.model,
    });
    return NextResponse.json({ answer: result.content });
  } catch (error) {
    if (attemptUserId) {
      await recordUsage({ userId: attemptUserId, feature: 'ask-region:error', model: attemptModel });
    }
    await reportError(error, { routePath: '/api/ai/ask-region', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not answer that.' },
      { status: 500 },
    );
  }
}
