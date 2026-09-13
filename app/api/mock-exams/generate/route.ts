import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { requireTextAi } from '@/lib/ai-credentials';
import { checkAiAllowance, recordUsage } from '@/lib/rate-limit';
import { createPredictedPaper } from '@/lib/predicted-paper';
import { getLearnerContext, LearnerContextError } from '@/lib/learner-context';
import { MAX_EXAM_ITEMS, MAX_KEYED_EXAM_ITEMS } from '@/lib/mock-exam-limits';
import { selectBankQuestions, totalMarksOf } from '@/lib/mock-exam-selection';
import { toBankSubjectCodes } from '@/lib/bank-questions';

export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at this ceiling regardless of what the request
 * is doing. This project is on Pro, where the ceiling is 300s; 60 was a
 * Hobby-era number and was never revisited.
 *
 * A plain mock exam no longer goes anywhere near that: selection is one indexed
 * query. The budget still matters for `mode: 'predicted'`, which is the one
 * path here that still calls a model.
 */
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) ?? {};
    const {
      subjectCode,
      courseId,
      topics = [],
      totalMarks = 50,
      durationMinutes = 90,
      difficulty = 'mixed',
      questionCount,
      title,
      mode = 'mock',
      paperNumber,
    } = body as {
      subjectCode?: string;
      courseId?: string;
      topics?: string[];
      totalMarks?: number;
      durationMinutes?: number;
      difficulty?: string;
      questionCount?: number;
      title?: string;
      mode?: 'mock' | 'predicted';
      paperNumber?: number;
    };

    let learnerContext;
    try {
      learnerContext = await getLearnerContext({ userId: user.id, explicitCourseId: courseId, legacySubjectCode: subjectCode, prompt: `${title ?? ''} ${topics.join(' ')} mock exam` });
    } catch (error) {
      if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status });
      throw error;
    }
    if (learnerContext.clarificationRequired) {
      return NextResponse.json({ error: 'Choose a course before generating the exam.', clarificationRequired: true, eligibleCourses: learnerContext.eligibleCourses }, { status: 409 });
    }
    const resolvedSubjectCode = learnerContext.activeCourse?.scopes.find((scope) => !subjectCode || scope.subjectCode === subjectCode)?.subjectCode
      ?? learnerContext.activeCourse?.scopes[0]?.subjectCode;
    if (!resolvedSubjectCode) return NextResponse.json({ error: 'The selected course needs a curriculum mapping before an exam can be generated.' }, { status: 409 });

    const subject = await prisma.subject.findUnique({ where: { code: resolvedSubjectCode } });
    if (!subject) {
      return NextResponse.json({ error: `Unknown subject code: ${resolvedSubjectCode}` }, { status: 404 });
    }

    if (mode === 'predicted') {
      // Only the predicted paper still asks a model to do anything, so only it
      // needs a credential. A plain mock exam is a database query now, and
      // gating it on AI access would refuse a paper we can build for free.
      const access = await requireTextAi(user.id);
      if (!access.ok) {
        return NextResponse.json(
          { error: access.error, reason: access.reason, aiDisabled: true },
          { status: access.status }
        );
      }

      const allowance = await checkAiAllowance(user.id, { source: access.source });
      if (!allowance.allowed) {
        return NextResponse.json({ error: allowance.message }, { status: 429 });
      }

      const predicted = await createPredictedPaper({
        userId: user.id,
        credential: access.credential,
        subjectCode: resolvedSubjectCode,
        topics,
        totalMarks,
        durationMinutes,
        difficulty,
        questionCount,
        title,
        paperNumber,
      });
      await recordUsage({
        userId: user.id,
        feature: 'mock-exam-generate',
        // The provider's own counts where it reports them. The flat 1500 that
        // used to sit here booked no input tokens at all, so a predicted paper
        // over a large candidate catalogue -- by far the biggest prompt the app
        // sends -- was recorded as costing nothing.
        tokensIn: predicted.usage?.promptTokens,
        tokensOut: predicted.usage?.completionTokens ?? 1500,
        model: access.credential.model,
      });
      return NextResponse.json({ exam: predicted.exam, prediction: predicted.prediction, resolvedCourse: learnerContext.activeCourse });
    }

    // Selection is a query, not a model call.
    //
    // It reads `bank_questions` -- the crop-first corpus the pipeline fills --
    // rather than the legacy `past_paper_questions` table, which holds a few
    // dozen rows for three subjects and none for the rest. That alone is what
    // made five of eight enrolled subjects answer "No questions available for
    // this subject in the bank" while thousands sat in the bank.
    //
    // Because there is no provider in the path any more, the paper is finished
    // before this route answers: no `generating` state, no `after()`, no client
    // poll, and no way for a slow completion to strand a paper in `failed`.
    const bankSubjectCodes = toBankSubjectCodes([resolvedSubjectCode]);

    // Let the mark target decide how many questions a paper holds, and cap the
    // count only where a cap is actually needed.
    //
    // This used to guess `totalMarks / 6`, which assumes a six-mark structured
    // question. Most of this bank is one-mark multiple choice, so a 50-mark
    // request became eight items -- and eight marks. The mark target is the
    // thing the student asked for; the item count is downstream of it.
    const requestedCount =
      typeof questionCount === 'number' && Number.isFinite(questionCount)
        ? Math.round(questionCount)
        : MAX_KEYED_EXAM_ITEMS;
    const targetCount = Math.max(1, Math.min(MAX_KEYED_EXAM_ITEMS, requestedCount));

    const selected = await selectBankQuestions({
      subjectCodes: bankSubjectCodes,
      targetMarks: totalMarks,
      maxItems: targetCount,
      // Only questions needing a model constrain the invocation.
      maxUnkeyedItems: MAX_EXAM_ITEMS,
    });

    if (selected.length === 0) {
      return NextResponse.json(
        {
          error:
            `No questions with a mark scheme are available for ${subject.name} yet. ` +
            'Try another subject, or browse the question bank directly.',
        },
        { status: 404 }
      );
    }

    const exam = await prisma.mockExam.create({
      data: {
        userId: user.id,
        title: title || `${subject.name} Mock Exam`,
        description:
          `${selected.length} questions from past ${subject.name} papers, ` +
          `${totalMarksOf(selected)} marks.`,
        subjectCode: subject.code,
        durationMinutes,
        totalMarks: totalMarksOf(selected),
        topics,
        difficulty,
        // Finished on creation. Nothing runs after this point, so there is no
        // window in which the paper exists without its questions.
        status: 'generated',
        items: {
          create: selected.map((question, order) => ({
            bankQuestionId: question.id,
            sectionTitle: 'Section A',
            order,
          })),
        },
      },
      include: { items: true },
    });

    return NextResponse.json({ exam, resolvedCourse: learnerContext.activeCourse });
  } catch (error) {
    console.error('Mock exam generation failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate mock exam' },
      { status: 500 }
    );
  }
}
