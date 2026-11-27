/**
 * Attempts at crop-first bank questions.
 *
 * A sibling of /api/attempts and /api/practice rather than an extension of
 * either: there are three question tables and a foreign key can only point at
 * one, so each has its own attempt table. Until this route existed the bank had
 * no attempt path at all, and the dashboard's "Questions Answered" tile was
 * pinned at zero by the schema rather than by how much anyone studied.
 *
 * Where the mark scheme carries an answer key -- the multiple-choice half of
 * Physics, Biology, Chemistry and Economics -- a character comparison settles
 * it in the request. Everything else is either marked by the AI on request
 * (`markWith: 'ai'`: typed text, a handwritten answer from the answer box, or
 * both) or recorded unmarked and handed back with the mark scheme for the
 * student to mark themselves.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { gradeAgainstKey } from '@/lib/bank-grading';
import { upsertBankMistakeReview } from '@/lib/learning';
import { SelfMarkError, resolveSelfMark } from '@/lib/self-marking';
import { subjectNameForCode } from '@/lib/course-catalog';
import { reportError } from '@/lib/error-reporting';
import { aiVerdictFrom, bankGradeFields, gradeBankAnswer } from '@/lib/bank-ai-grading';

export const dynamic = 'force-dynamic';

/** One vision grade of a handwritten answer runs to ~30s and past it. */
export const maxDuration = 120;
const AI_GRADE_BUDGET_MS = (maxDuration - 20) * 1000;

const AttemptBody = z.object({
  questionId: z.number().int().positive(),
  // May be empty when the answer was written by hand: the ink is read from the
  // question's autosaved scratchpad, checked below.
  answer: z.string().max(10000),
  /** Ask the AI to mark a free-response answer instead of leaving it to the student. */
  markWith: z.enum(['ai']).optional(),
  timeSpent: z.number().int().nonnegative().max(60 * 60 * 24).optional(),
  /**
   * Marks the student awarded themselves against the mark scheme.
   *
   * Preferred over `selfMarkedCorrect` wherever the question carries a mark
   * total, which is most of what is worth self-marking: a 12-mark extended
   * response recorded as a single true/false threw away everything the student
   * learned by marking it.
   */
  awardedMarks: z.number().int().nonnegative().max(200).optional(),
  /**
   * The older binary verdict. Still accepted, and still the only option for a
   * question the corpus never captured a mark total for -- most of the bank,
   * since a total is only recorded where the paper printed one.
   */
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
      awardedMarks: true,
      outOfMarks: true,
      aiFeedback: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ attempts });
}

/**
 * Raise a spaced-review card for a question just marked wrong.
 *
 * Shared by POST and PATCH: a question marked wrong when the student marks it
 * themselves earns a card exactly as one marked wrong by an answer key does.
 * Before self-marking could be recorded, only the key path could ever reach
 * this, so the whole free-response half of the bank raised no cards at all.
 */
async function raiseReviewCard(
  userId: string,
  question: {
    id: number;
    rootNumber: number;
    bodyMd: string;
    paper: { subject: { code: string; name: string } };
  },
  markScheme: { answerLetter: string | null; answerMd: string | null; _count: { strips: number } } | null,
) {
  await upsertBankMistakeReview({
    userId,
    bankQuestionId: question.id,
    prompt:
      question.bodyMd.trim() || `Question ${question.rootNumber} — see the original paper`,
    answer: markScheme?.answerMd,
    answerLetter: markScheme?.answerLetter ?? null,
    hasMarkSchemeStrips: (markScheme?._count.strips ?? 0) > 0,
    subject: subjectNameForCode(question.paper.subject.code) ?? question.paper.subject.name,
    topic: 'General',
  });
}

const SelfMarkBody = z.object({
  attemptId: z.string().min(1).max(64),
  awardedMarks: z.number().int().nonnegative().max(200).optional(),
  selfMarkedCorrect: z.boolean().optional(),
});

/**
 * PATCH /api/bank/attempts — mark an attempt the student already saved.
 *
 * Separate from POST because the two happen minutes apart: the answer is
 * written before the mark scheme is revealed, and the mark comes after reading
 * it. Recording the mark as a second attempt would double every free-response
 * question in the history and halve its apparent accuracy.
 *
 * Only an attempt belonging to this user, and only one that is not already
 * marked -- so a student cannot revise a verdict after seeing what it did to
 * their statistics.
 */
export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof SelfMarkBody>;
  try {
    body = SelfMarkBody.parse(await req.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid mark' },
      { status: 400 },
    );
  }

  const attempt = await prisma.bankQuestionAttempt.findFirst({
    where: { id: body.attemptId, userId: user.id },
    select: {
      id: true,
      isCorrect: true,
      question: {
        select: {
          id: true,
          rootNumber: true,
          bodyMd: true,
          totalMarks: true,
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
      },
    },
  });

  if (!attempt) return NextResponse.json({ error: 'Attempt not found' }, { status: 404 });
  if (attempt.isCorrect !== null) {
    return NextResponse.json({ error: 'That attempt is already marked.' }, { status: 409 });
  }

  const markScheme =
    attempt.question.markScheme?.status === 'published' ? attempt.question.markScheme : null;

  let selfMark: ReturnType<typeof resolveSelfMark>;
  try {
    selfMark = resolveSelfMark(
      {
        totalMarks: attempt.question.totalMarks,
        hasAnswerKey: (markScheme?.answerLetter ?? null) !== null,
      },
      { awardedMarks: body.awardedMarks, selfMarkedCorrect: body.selfMarkedCorrect },
    );
  } catch (error) {
    if (error instanceof SelfMarkError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  if (!selfMark) {
    return NextResponse.json({ error: 'No mark was given.' }, { status: 400 });
  }

  try {
    const updated = await prisma.bankQuestionAttempt.update({
      where: { id: attempt.id },
      data: {
        isCorrect: selfMark.isCorrect,
        score: selfMark.score,
        selfAwardedScore: selfMark.score,
        awardedMarks: selfMark.awardedMarks,
        outOfMarks: selfMark.awardedMarks === null ? null : attempt.question.totalMarks,
        gradedBy: 'self',
      },
      select: {
        id: true,
        isCorrect: true,
        score: true,
        awardedMarks: true,
        outOfMarks: true,
        gradedBy: true,
      },
    });

    // Full marks is the only thing that is not a mistake. A 5/6 leaves a mark
    // on the table, and that is exactly what spaced review is for.
    if (!selfMark.isCorrect) {
      await raiseReviewCard(user.id, attempt.question, markScheme);
    }

    return NextResponse.json({ attempt: updated });
  } catch (error) {
    reportError(error, {
      routePath: '/api/bank/attempts',
      routeType: 'route',
      method: 'PATCH',
    });
    return NextResponse.json({ error: 'Could not save your mark' }, { status: 500 });
  }
}

/**
 * POST /api/bank/attempts — record and, where possible, mark an attempt.
 *
 * Body: { questionId, answer, timeSpent?, awardedMarks?, selfMarkedCorrect? }
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
      totalMarks: true,
      paper: { select: { subject: { select: { code: true, name: true, board: true } } } },
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

  // A scratchpad autosaves while the student is still working, ahead of this
  // attempt row existing at all -- if they drew a diagram, its flattened
  // snapshot is the picture of their working.
  const scratchpad = await prisma.questionScratchpad.findFirst({
    where: { userId: user.id, bankQuestionId: question.id },
  });

  // An unpublished mark scheme is not an answer key we should mark against,
  // nor one to put on the back of a review card.
  const publishedMarkScheme =
    question.markScheme?.status === 'published' ? question.markScheme : null;
  const answerLetter = publishedMarkScheme?.answerLetter ?? null;

  const answerImageUrl = scratchpad?.previewImageUrl ?? null;
  if (!body.answer.trim() && !answerImageUrl) {
    return NextResponse.json({ error: 'Write or type an answer first' }, { status: 400 });
  }

  const keyGrade = gradeAgainstKey(body.answer, answerLetter);

  // AI marking: only where there is no key (a key outranks any model) and the
  // student has not already given their own mark.
  let aiGrade: Awaited<ReturnType<typeof gradeBankAnswer>> | null = null;
  if (!keyGrade && body.markWith === 'ai' && body.awardedMarks === undefined && body.selfMarkedCorrect === undefined) {
    aiGrade = await gradeBankAnswer({
      userId: user.id,
      questionText: question.bodyMd,
      // The board keeps CAIE Economics out of the IB economics guidance.
      subject: `${question.paper.subject.board} ${question.paper.subject.name} ${question.paper.subject.code}`,
      totalMarks: question.totalMarks,
      typed: body.answer.trim(),
      imageUrl: answerImageUrl,
      markscheme: publishedMarkScheme?.answerMd?.trim() || null,
      budgetMs: AI_GRADE_BUDGET_MS,
    });
    if (!aiGrade.graded && aiGrade.status === 429) {
      return NextResponse.json({ error: aiGrade.notice }, { status: 429 });
    }
  }
  const aiFields = aiGrade?.graded ? bankGradeFields(aiGrade.grade, question.totalMarks) : null;

  // Precedence matters: a real answer key outranks the student's own verdict,
  // so self-marking cannot be used to score a multiple-choice question correct.
  // `resolveSelfMark` enforces that too, rather than trusting this order.
  let selfMark: ReturnType<typeof resolveSelfMark> = null;
  if (!keyGrade && (body.awardedMarks !== undefined || body.selfMarkedCorrect !== undefined)) {
    try {
      selfMark = resolveSelfMark(
        { totalMarks: question.totalMarks, hasAnswerKey: answerLetter !== null },
        { awardedMarks: body.awardedMarks, selfMarkedCorrect: body.selfMarkedCorrect },
      );
    } catch (error) {
      if (error instanceof SelfMarkError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  }

  const marked =
    keyGrade ??
    (aiFields
      ? { isCorrect: aiFields.isCorrect, score: aiFields.score, gradedBy: 'ai' as const, correctLetter: null }
      : null) ??
    (selfMark
      ? {
          isCorrect: selfMark.isCorrect,
          score: selfMark.score,
          gradedBy: 'self' as const,
          correctLetter: null,
        }
      : null);

  const aiVerdict = aiGrade?.graded ? aiVerdictFrom(aiGrade) : null;

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
        // Kept apart from `score` so marking bias stays measurable later: which
        // of the two marked this attempt is not recoverable from a fraction.
        selfAwardedScore: selfMark ? selfMark.score : null,
        authoritativeScore: keyGrade ? keyGrade.score : null,
        awardedMarks: aiFields?.awardedMarks ?? selfMark?.awardedMarks ?? null,
        outOfMarks: aiFields ? aiFields.outOfMarks : selfMark?.awardedMarks === null ? null : question.totalMarks,
        timeSpent: body.timeSpent,
        answerImageUrl,
        gradingMode: aiGrade?.graded ? aiGrade.mode : 'text',
        // Stored so the student can reread it when they come back to the
        // question; the marks alone say how they did, not why.
        ...(aiVerdict ? { aiFeedback: aiVerdict } : {}),
      },
      select: {
        id: true,
        isCorrect: true,
        score: true,
        gradedBy: true,
        awardedMarks: true,
        outOfMarks: true,
        createdAt: true,
      },
    });

    if (scratchpad) {
      // Keep the row (a reopened past attempt can still show the drawing) --
      // only stamp it as belonging to a submitted attempt now.
      await prisma.questionScratchpad.update({
        where: { id: scratchpad.id },
        data: { finalizedAt: new Date() },
      });
    }

    // A wrong answer is what spaced review exists for. Raising the card here
    // rather than only on mock-exam submission matters because Practice is
    // where most attempts happen; `upsertBankMistakeReview` declines to create
    // one when there would be nothing on the back of it.
    if (marked?.isCorrect === false) {
      await raiseReviewCard(user.id, question, publishedMarkScheme);
    }

    return NextResponse.json({
      attempt,
      // Null when there is no key, which is the client's signal to reveal the
      // mark scheme and ask the student to mark it themselves.
      correctLetter: keyGrade?.correctLetter ?? null,
      // What the client should offer for that: a mark stepper where the
      // question carries a total, the old true/false where it does not.
      totalMarks: question.totalMarks,
      // The AI's verdict, when one was asked for (also stored on the attempt).
      ai: aiVerdict ?? (aiGrade && !aiGrade.graded ? { graded: false, notice: aiGrade.notice } : null),
    });
  } catch (error) {
    reportError(error, { routePath: '/api/bank/attempts', routeType: 'route', method: 'POST' });
    return NextResponse.json({ error: 'Could not save the attempt' }, { status: 500 });
  }
}
