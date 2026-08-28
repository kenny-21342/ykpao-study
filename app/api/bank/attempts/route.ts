/**
 * Attempts at crop-first bank questions.
 *
 * A sibling of /api/attempts and /api/practice rather than an extension of
 * either: there are three question tables and a foreign key can only point at
 * one, so each has its own attempt table. Until this route existed the bank had
 * no attempt path at all, and the dashboard's "Questions Answered" tile was
 * pinned at zero by the schema rather than by how much anyone studied.
 *
 * Marking happens here and not through the model. Where the mark scheme carries
 * an answer key -- the multiple-choice half of Physics, Biology, Chemistry and
 * Economics -- a character comparison settles it in the request. Everything
 * else is recorded unmarked and handed back with the mark scheme for the
 * student to mark themselves.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { gradeAgainstKey } from '@/lib/bank-grading';
import { upsertBankMistakeReview } from '@/lib/learning';
import { subjectNameForCode } from '@/lib/course-catalog';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

const AttemptBody = z.object({
  questionId: z.number().int().positive(),
  answer: z.string().min(1).max(10000),
  timeSpent: z.number().int().nonnegative().max(60 * 60 * 24).optional(),
  /** Set when the student marked their own free-response work. */
  selfMarkedCorrect: z.boolean().optional(),
});

/**
 * GET /api/bank/attempts?questionId=123
 *
 * This user's history for one question, newest first. The detail view uses it
 * to show previous tries; without a questionId it returns nothing, because the
 * dashboard reads aggregates from /api/dashboard rather than pulling every
 * attempt across the whole bank.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const questionId = Number.parseInt(
    new URL(req.url).searchParams.get('questionId') || '',
    10,
  );
  if (!Number.isFinite(questionId) || questionId <= 0) {
    return NextResponse.json({ error: 'Question ID required' }, { status: 400 });
  }

  const attempts = await prisma.bankQuestionAttempt.findMany({
    where: { userId: user.id, questionId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      answer: true,
      isCorrect: true,
      score: true,
      gradedBy: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ attempts });
}

/**
 * POST /api/bank/attempts — record and, where possible, mark an attempt.
 *
 * Body: { questionId, answer, timeSpent?, selfMarkedCorrect? }
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof AttemptBody>;
  try {
    body = AttemptBody.parse(await req.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid attempt' },
      { status: 400 },
    );
  }

  // Only a published question can be attempted. Anything else is held back by
  // the crop QA, and marking a student against a question we know is damaged
  // would put a wrong answer in their history through no fault of theirs.
  const question = await prisma.bankQuestion.findFirst({
    where: { id: body.questionId, status: 'published' },
    select: {
      id: true,
      rootNumber: true,
      bodyMd: true,
      paper: { select: { subject: { select: { code: true, name: true } } } },
      markScheme: {
        select: {
          status: true,
          answerLetter: true,
          answerMd: true,
          _count: { select: { strips: true } },
        },
      },
    },
  });
  if (!question) return NextResponse.json({ error: 'Question not found' }, { status: 404 });

  // An unpublished mark scheme is not an answer key we should mark against,
  // nor one to put on the back of a review card.
  const publishedMarkScheme =
    question.markScheme?.status === 'published' ? question.markScheme : null;
  const answerLetter = publishedMarkScheme?.answerLetter ?? null;

  const keyGrade = gradeAgainstKey(body.answer, answerLetter);

  // Precedence matters: a real answer key outranks the student's own verdict,
  // so self-marking cannot be used to score a multiple-choice question correct.
  const marked =
    keyGrade ??
    (body.selfMarkedCorrect === undefined
      ? null
      : {
          isCorrect: body.selfMarkedCorrect,
          score: body.selfMarkedCorrect ? 1 : 0,
          gradedBy: 'self' as const,
          correctLetter: null,
        });

  try {
    const attempt = await prisma.bankQuestionAttempt.create({
      data: {
        userId: user.id,
        questionId: body.questionId,
        answer: body.answer,
        isCorrect: marked?.isCorrect ?? null,
        score: marked?.score ?? null,
        // 'self' also covers the not-yet-marked case: the student has the mark
        // scheme in front of them and the verdict is theirs to give.
        gradedBy: marked?.gradedBy ?? 'self',
        timeSpent: body.timeSpent,
      },
      select: { id: true, isCorrect: true, score: true, gradedBy: true, createdAt: true },
    });

    // A wrong answer is what spaced review exists for. Raising the card here
    // rather than only on mock-exam submission matters because Practice is
    // where most attempts happen; `upsertBankMistakeReview` declines to create
    // one when there would be nothing on the back of it.
    if (marked?.isCorrect === false) {
      await upsertBankMistakeReview({
        userId: user.id,
        bankQuestionId: question.id,
        prompt:
          question.bodyMd.trim() ||
          `Question ${question.rootNumber} — see the original paper`,
        answer: publishedMarkScheme?.answerMd,
        answerLetter,
        hasMarkSchemeStrips: (publishedMarkScheme?._count.strips ?? 0) > 0,
        subject: subjectNameForCode(question.paper.subject.code) ?? question.paper.subject.name,
        topic: 'General',
      });
    }

    return NextResponse.json({
      attempt,
      // Null when there is no key, which is the client's signal to reveal the
      // mark scheme and ask the student to mark it themselves.
      correctLetter: keyGrade?.correctLetter ?? null,
    });
  } catch (error) {
    reportError(error, { routePath: '/api/bank/attempts', routeType: 'route', method: 'POST' });
    return NextResponse.json({ error: 'Could not save the attempt' }, { status: 500 });
  }
}
