import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { PLACEHOLDER_ANSWER, plainText, scheduleReview } from '@/lib/learning';
import { resolveCourseScope } from '@/lib/course-scope';
import { LearnerContextError } from '@/lib/learner-context';

export const dynamic = 'force-dynamic';

const CreateReview = z.object({
  questionId: z.number().int().positive().optional(),
  prompt: z.string().trim().min(1).max(5000).optional(),
  answer: z.string().trim().min(1).max(5000).optional(),
  subject: z.string().trim().min(1).max(100).optional(),
  topic: z.string().trim().min(1).max(120).optional(),
});

const UpdateReview = z.object({
  id: z.string().min(1),
  rating: z.enum(['again', 'hard', 'good', 'easy']).optional(),
  status: z.enum(['active', 'mastered', 'archived']).optional(),
});

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const mode = params.get('mode') ?? 'due';
  let courseScope;
  try {
    courseScope = await resolveCourseScope({ userId: user.id, scope: params.get('scope'), courseId: params.get('courseId') });
  } catch (error) {
    if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  const reviews = await prisma.reviewItem.findMany({
    where: {
      userId: user.id,
      ...(mode !== 'all' ? { status: 'active' } : {}),
      ...(mode === 'due' ? { nextReviewAt: { lte: new Date() } } : {}),
      // Cards whose answer is the old placeholder string are unanswerable and
      // must not be served. `scripts/repair-placeholder-reviews.ts` clears the
      // rows; this keeps any that survive out of the queue, and costs nothing
      // once they are gone.
      answer: { not: PLACEHOLDER_ANSWER },
      ...(courseScope.effectiveScope === 'enrolled' ? { subject: { in: courseScope.subjects } } : {}),
    },
    include: {
      question: {
        select: {
          number: true,
          part: true,
          subPart: true,
          paper: { select: { year: true, session: true, paperNumber: true, variant: true, subject: true } },
        },
      },
    },
    orderBy: [{ nextReviewAt: 'asc' }, { createdAt: 'desc' }],
    take: 100,
  });

  return NextResponse.json({ reviews, scope: courseScope });
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof CreateReview>;
  try {
    body = CreateReview.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid review item' }, { status: 400 });
  }

  if (!body.questionId && (!body.prompt || !body.answer || !body.subject || !body.topic)) {
    return NextResponse.json({ error: 'Manual reviews need prompt, answer, subject, and topic' }, { status: 400 });
  }

  if (body.questionId) {
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

    const review = await prisma.reviewItem.upsert({
      where: { userId_questionId: { userId: user.id, questionId: question.id } },
      create: {
        userId: user.id,
        questionId: question.id,
        prompt: body.prompt ?? plainText(question.content, 5000),
        answer: body.answer ?? plainText(markscheme?.content || 'Review your attempt and reconstruct a complete answer.', 5000),
        subject: body.subject ?? question.paper.subject.name,
        topic: body.topic ?? question.topic,
      },
      update: {
        status: 'active',
        nextReviewAt: new Date(),
        ...(body.prompt && { prompt: body.prompt }),
        ...(body.answer && { answer: body.answer }),
      },
    });
    return NextResponse.json({ review }, { status: 201 });
  }

  const review = await prisma.reviewItem.create({
    data: {
      userId: user.id,
      questionId: null,
      prompt: body.prompt!,
      answer: body.answer!,
      subject: body.subject!,
      topic: body.topic!,
    },
  });
  return NextResponse.json({ review }, { status: 201 });
}

export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof UpdateReview>;
  try {
    body = UpdateReview.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid review update' }, { status: 400 });
  }

  const existing = await prisma.reviewItem.findFirst({ where: { id: body.id, userId: user.id } });
  if (!existing) return NextResponse.json({ error: 'Review item not found' }, { status: 404 });

  const scheduled = body.rating ? scheduleReview(existing, body.rating) : null;
  const review = await prisma.reviewItem.update({
    where: { id: existing.id },
    data: {
      ...(body.status && { status: body.status }),
      ...(scheduled && {
        ...scheduled,
        status: scheduled.repetitions >= 5 && scheduled.intervalDays >= 30 ? 'mastered' : 'active',
        lastReviewedAt: new Date(),
      }),
    },
  });
  return NextResponse.json({ review });
}
