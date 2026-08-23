import { after, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { chatJSON, SYSTEM_PROMPTS, DeepSeekError } from '@/lib/ai';
import { requireTextAi } from '@/lib/ai-credentials';
import { checkAiAllowance, recordUsage } from '@/lib/rate-limit';
import { createPredictedPaper } from '@/lib/predicted-paper';
import type { MockExamPlan } from '@/types/ai';
import { getLearnerContext, LearnerContextError } from '@/lib/learner-context';
import { MAX_EXAM_ITEMS } from '@/lib/mock-exam-limits';

export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at the platform default (60s Hobby / 300s Pro)
 * regardless of what the request is doing.
 */
export const maxDuration = 60;

const MAX_CANDIDATES = 60;

/**
 * Wall-clock budget for the selection call, which runs in `after()` once the
 * response is already sent. Nothing is waiting on it, so it can use most of
 * `maxDuration` rather than the 45s default in lib/ai.ts -- that default
 * exists to leave a synchronous route time to answer, and this route has
 * already answered.
 */
const SELECTION_BUDGET_MS = 50_000;

/**
 * One attempt, not two.
 *
 * `chat()` splits its budget across attempts (60% to the first), so two tries
 * would give this call 30s and then 20s. The observed failure is a single slow
 * completion, not a flaky one, and 50s in one attempt clears it where neither
 * half would. A student can retry from the UI; a truncated retry helps nobody.
 */
const SELECTION_ATTEMPTS = 1;

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Resolve credentials before any of the expensive bank queries: a student
    // with AI switched off should be told so immediately, not after a scan of
    // the question bank.
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
        tokensOut: 1500,
        model: access.credential.model,
      });
      return NextResponse.json({ exam: predicted.exam, prediction: predicted.prediction, resolvedCourse: learnerContext.activeCourse });
    }

    // Pull a candidate pool from the question bank (question papers only)
    const pool = await prisma.pastPaperQuestion.findMany({
      where: {
        paper: {
          subjectId: subject.id,
          docType: 'qp',
        },
        marks: { gt: 0 },
      },
      include: { paper: true },
      take: MAX_CANDIDATES,
      orderBy: { paper: { year: 'desc' } },
    });

    if (pool.length === 0) {
      return NextResponse.json(
        { error: 'No questions available for this subject in the bank.' },
        { status: 404 }
      );
    }

    // Compose a compact catalogue for the AI to choose from
    const catalogue = pool.map((q) => ({
      id: q.id,
      year: q.paper.year,
      session: q.paper.session,
      paperNumber: q.paper.paperNumber,
      number: q.number,
      part: q.part,
      subPart: q.subPart,
      marks: q.marks,
      preview: q.content.slice(0, 220),
    }));

    // `questionCount` comes straight from the request body. Clamp it to what a
    // submission can actually grade inside one function invocation — an exam
    // larger than MAX_EXAM_ITEMS would generate fine and then be impossible to
    // submit, which is a much worse failure than a smaller paper.
    const requestedCount =
      typeof questionCount === 'number' && Number.isFinite(questionCount)
        ? Math.round(questionCount)
        : Math.max(4, Math.min(20, Math.round(totalMarks / 6)));
    const targetCount = Math.max(1, Math.min(MAX_EXAM_ITEMS, requestedCount));

    const userContent = `Design a mock exam paper.

Subject: ${subject.name} (${subject.code})
Target total marks: ${totalMarks}
Duration (minutes): ${durationMinutes}
Difficulty: ${difficulty}
${topics.length ? `Topics to focus on: ${topics.join(', ')}\n` : ''}Approximate number of questions: ${targetCount}

Pick ONLY from this question bank (use the provided ids):
${JSON.stringify(catalogue)}

Return JSON matching the schema. Group selected questions into 1-3 sections by theme.`;

    // The paper row is created empty and filled in afterwards. Selecting the
    // questions is one LLM call over the whole candidate catalogue, and on a
    // slow provider day it outlasts any budget a request can wait for -- in
    // production it was returning 504 at ~46s for every size of paper,
    // including three questions. Answering now and finishing in `after()`
    // turns that from a dead request into a paper that is visibly still
    // being built, and gives the call most of `maxDuration` instead of the
    // slice a waiting client can afford.
    const exam = await prisma.mockExam.create({
      data: {
        userId: user.id,
        title: title || `${subject.name} Mock Exam`,
        description: `Choosing questions for your ${subject.name} paper…`,
        subjectCode: subject.code,
        durationMinutes,
        // Filled in from the real questions once they are chosen.
        totalMarks: 0,
        topics,
        difficulty,
        status: 'generating',
      },
      include: { items: true },
    });

    after(async () => {
      try {
        const plan = await chatJSON<MockExamPlan>(
          [
            { role: 'system', content: SYSTEM_PROMPTS.examGenerator },
            { role: 'user', content: userContent },
          ],
          {
            credential: access.credential,
            temperature: 0.4,
            maxTokens: 2000,
            budgetMs: SELECTION_BUDGET_MS,
            maxAttempts: SELECTION_ATTEMPTS,
          }
        );

        await recordUsage({
          userId: user.id,
          feature: 'mock-exam-generate',
          tokensOut: 1500,
          model: access.credential.model,
        });

        // Flatten the AI plan into a list of { questionId, sectionTitle, order }
        const flatItems: Array<{ questionId: number; sectionTitle: string; order: number }> = [];
        let order = 0;
        for (const section of plan.sections ?? []) {
          for (const qid of section.questionIds ?? []) {
            // `targetCount` is only a hint in the prompt -- the model routinely
            // returns more. Enforce the ceiling here, or the exam is created at
            // a size that can never be submitted.
            if (flatItems.length >= MAX_EXAM_ITEMS) break;
            if (pool.some((candidate) => candidate.id === qid)) {
              flatItems.push({
                questionId: qid,
                sectionTitle: section.title || 'Section A',
                order: order++,
              });
            }
          }
          if (flatItems.length >= MAX_EXAM_ITEMS) break;
        }

        if (flatItems.length === 0) {
          await failGeneration(
            exam.id,
            'The AI did not pick any valid questions. Try again, or widen the topics.'
          );
          return;
        }

        const computedMarks = await prisma.pastPaperQuestion.aggregate({
          where: { id: { in: flatItems.map((item) => item.questionId) } },
          _sum: { marks: true },
        });

        await prisma.mockExam.update({
          where: { id: exam.id },
          data: {
            title: title || plan.title || `${subject.name} Mock Exam`,
            description: plan.description || `AI-generated mock exam in ${subject.name}.`,
            durationMinutes: plan.durationMinutes || durationMinutes,
            totalMarks: computedMarks._sum.marks ?? totalMarks,
            status: 'generated',
            generationError: null,
            items: {
              create: flatItems.map((item) => ({
                questionId: item.questionId,
                sectionTitle: item.sectionTitle,
                order: item.order,
              })),
            },
          },
        });
      } catch (err) {
        // Nothing is waiting on this callback, so an unhandled throw would
        // leave the paper stuck on "generating" forever with no explanation.
        console.error('Mock exam generation failed for %s:', exam.id, err);
        await failGeneration(
          exam.id,
          err instanceof DeepSeekError
            ? err.message
            : 'Generating this paper failed. Please try again.'
        );
      }
    });

    // 202: the paper exists, its questions do not yet. The client polls
    // GET /api/mock-exams/[id] until `status` leaves 'generating'.
    return NextResponse.json(
      { exam, resolvedCourse: learnerContext.activeCourse },
      { status: 202 }
    );
  } catch (error) {
    console.error('Mock exam generation failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to generate mock exam' },
      { status: 500 }
    );
  }
}

/** Mark a paper as failed, without letting the bookkeeping throw in turn. */
async function failGeneration(examId: string, message: string) {
  try {
    await prisma.mockExam.update({
      where: { id: examId },
      data: { status: 'failed', generationError: message },
    });
  } catch (err) {
    console.error('Could not record generation failure for %s:', examId, err);
  }
}
