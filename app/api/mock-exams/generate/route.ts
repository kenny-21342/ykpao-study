import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { chatJSON, isAIConfigured, SYSTEM_PROMPTS, DeepSeekError } from '@/lib/ai';
import { aiLimiter, recordUsage } from '@/lib/rate-limit';
import { createPredictedPaper } from '@/lib/predicted-paper';
import type { MockExamPlan } from '@/types/ai';
import { getLearnerContext, LearnerContextError } from '@/lib/learner-context';

export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at the platform default (60s Hobby / 300s Pro)
 * regardless of what the request is doing. Generates and validates a whole paper: several LLM calls per request.
 */
export const maxDuration = 120;

const MAX_CANDIDATES = 60;

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!(await aiLimiter.check(`mock-exam-generate:${user.id}`))) {
      return NextResponse.json(
        { error: 'Too many AI requests. Please wait a moment and try again.' },
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
    if (!isAIConfigured()) {
      return NextResponse.json(
        { error: 'AI service not configured (DEEPSEEK_API_KEY missing)' },
        { status: 503 }
      );
    }

    const subject = await prisma.subject.findUnique({ where: { code: resolvedSubjectCode } });
    if (!subject) {
      return NextResponse.json({ error: `Unknown subject code: ${resolvedSubjectCode}` }, { status: 404 });
    }

    if (mode === 'predicted') {
      const predicted = await createPredictedPaper({
        userId: user.id,
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

    const targetCount = questionCount ?? Math.max(4, Math.min(20, Math.round(totalMarks / 6)));

    const userContent = `Design a mock exam paper.

Subject: ${subject.name} (${subject.code})
Target total marks: ${totalMarks}
Duration (minutes): ${durationMinutes}
Difficulty: ${difficulty}
${topics.length ? `Topics to focus on: ${topics.join(', ')}\n` : ''}Approximate number of questions: ${targetCount}

Pick ONLY from this question bank (use the provided ids):
${JSON.stringify(catalogue)}

Return JSON matching the schema. Group selected questions into 1-3 sections by theme.`;

    let plan: MockExamPlan;
    try {
      plan = await chatJSON<MockExamPlan>(
        [
          { role: 'system', content: SYSTEM_PROMPTS.examGenerator },
          { role: 'user', content: userContent },
        ],
        { temperature: 0.4, maxTokens: 2000 }
      );
    } catch (err) {
      if (err instanceof DeepSeekError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }

    await recordUsage({
      userId: user.id,
      feature: 'mock-exam-generate',
      tokensOut: 1500,
    });

    // Flatten the AI plan into a list of { questionId, sectionTitle, order }
    const flatItems: Array<{ questionId: number; sectionTitle: string; order: number }> = [];
    let order = 0;
    for (const section of plan.sections ?? []) {
      for (const qid of section.questionIds ?? []) {
        if (pool.some((p) => p.id === qid)) {
          flatItems.push({
            questionId: qid,
            sectionTitle: section.title || 'Section A',
            order: order++,
          });
        }
      }
    }

    if (flatItems.length === 0) {
      return NextResponse.json(
        { error: 'AI failed to pick any valid questions. Try again or adjust filters.' },
        { status: 422 }
      );
    }

    const computedMarks = await prisma.pastPaperQuestion.aggregate({
      where: { id: { in: flatItems.map((i) => i.questionId) } },
      _sum: { marks: true },
    });

    const examTitle = title || plan.title || `${subject.name} Mock Exam`;
    const exam = await prisma.mockExam.create({
      data: {
        userId: user.id,
        title: examTitle,
        description: plan.description || `AI-generated mock exam in ${subject.name}.`,
        subjectCode: subject.code,
        durationMinutes: plan.durationMinutes || durationMinutes,
        totalMarks: computedMarks._sum.marks ?? totalMarks,
        topics,
        difficulty,
        items: {
          create: flatItems.map((item) => ({
            questionId: item.questionId,
            sectionTitle: item.sectionTitle,
            order: item.order,
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
