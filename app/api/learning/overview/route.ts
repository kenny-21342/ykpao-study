import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { PLACEHOLDER_ANSWER, endOfDay, plainText, startOfDay } from '@/lib/learning';
import { resolveCourseScope } from '@/lib/course-scope';
import { LearnerContextError } from '@/lib/learner-context';

export const dynamic = 'force-dynamic';

type TopicCatalogRow = {
  subject: string;
  subjectCode: string;
  topic: string;
  total: bigint;
};

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const params = new URL(req.url).searchParams;
  let courseScope;
  try {
    courseScope = await resolveCourseScope({ userId: user.id, scope: params.get('scope'), courseId: params.get('courseId') });
  } catch (error) {
    if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  const subjectFilter = courseScope.effectiveScope === 'enrolled' ? { in: courseScope.subjects } : undefined;
  const codeFilter = courseScope.effectiveScope === 'enrolled' ? { in: courseScope.subjectCodes } : undefined;

  const now = new Date();
  const [profile, tasks, attempts, reviews, latestExam, catalog] = await Promise.all([
    prisma.learningProfile.findUnique({ where: { userId: user.id } }),
    prisma.studyTask.findMany({
      where: { userId: user.id, dueAt: { lte: endOfDay(now) }, status: 'pending', ...(subjectFilter ? { subject: subjectFilter } : {}) },
      orderBy: { dueAt: 'asc' },
      take: 30,
    }),
    prisma.pastPaperAttempt.findMany({
      where: { userId: user.id, gradingStatus: 'official', ...(codeFilter ? { question: { paper: { subject: { code: codeFilter } } } } : {}) },
      orderBy: { attemptedAt: 'desc' },
      take: 600,
      select: {
        id: true,
        questionId: true,
        answer: true,
        score: true,
        maxScore: true,
        isCorrect: true,
        strengths: true,
        weaknesses: true,
        explanation: true,
        modelAnswer: true,
        attemptedAt: true,
        question: {
          select: {
            content: true,
            topic: true,
            marks: true,
            number: true,
            part: true,
            subPart: true,
            paper: {
              select: {
                year: true,
                session: true,
                paperNumber: true,
                variant: true,
                subject: { select: { name: true, code: true } },
              },
            },
          },
        },
      },
    }),
    prisma.reviewItem.findMany({
      where: {
        userId: user.id,
        ...(subjectFilter ? { subject: subjectFilter } : {}),
      // Cards whose answer is the old placeholder string are unanswerable and
      // must not be served. `scripts/repair-placeholder-reviews.ts` clears the
      // rows; this keeps any that survive out of the queue, and costs nothing
      // once they are gone.
      answer: { not: PLACEHOLDER_ANSWER },
      },
      orderBy: { nextReviewAt: 'asc' },
      take: 200,
    }),
    prisma.mockExam.findFirst({
      where: { userId: user.id, status: 'completed', ...(codeFilter ? { subjectCode: codeFilter } : {}) },
      orderBy: { submittedAt: 'desc' },
      select: { id: true, title: true, score: true, totalMarks: true, submittedAt: true, subjectCode: true },
    }),
    prisma.$queryRaw<TopicCatalogRow[]>`
      SELECT s."name" AS "subject", s."code" AS "subjectCode", q."topic", COUNT(q."id") AS "total"
      FROM "past_paper_questions" q
      JOIN "past_papers" p ON p."id" = q."paperId"
      JOIN "subjects" s ON s."id" = p."subjectId"
      WHERE q."docType" = 'qp'
      ${courseScope.effectiveScope === 'enrolled'
        ? courseScope.subjectCodes.length > 0
          ? Prisma.sql`AND s."code" IN (${Prisma.join(courseScope.subjectCodes)})`
          : Prisma.sql`AND FALSE`
        : Prisma.empty}
      GROUP BY s."name", s."code", q."topic"
      ORDER BY s."name", q."topic"
    `,
  ]);

  const reviewByQuestion = new Map(reviews.filter((item) => item.questionId).map((item) => [item.questionId, item]));
  const seenMistakes = new Set<number>();
  const mistakes = attempts
    .filter((attempt) => {
      if (attempt.isCorrect !== false || seenMistakes.has(attempt.questionId)) return false;
      seenMistakes.add(attempt.questionId);
      return true;
    })
    .slice(0, 40)
    .map((attempt) => ({
      attemptId: attempt.id,
      questionId: attempt.questionId,
      question: plainText(attempt.question.content, 260),
      subject: attempt.question.paper.subject.name,
      subjectCode: attempt.question.paper.subject.code,
      topic: attempt.question.topic,
      code: questionCode(attempt.question),
      score: attempt.score,
      maxScore: attempt.maxScore,
      answer: plainText(attempt.answer, 300),
      explanation: attempt.explanation,
      modelAnswer: attempt.modelAnswer,
      weaknesses: attempt.weaknesses,
      attemptedAt: attempt.attemptedAt,
      reviewId: reviewByQuestion.get(attempt.questionId)?.id ?? null,
    }));

  const progress = new Map<string, {
    attemptedIds: Set<number>;
    score: number;
    max: number;
    correct: number;
    attempts: number;
    lastAttemptedAt: Date;
  }>();

  for (const attempt of attempts) {
    const subject = attempt.question.paper.subject.name;
    const key = `${subject}::${attempt.question.topic}`;
    const row = progress.get(key) ?? {
      attemptedIds: new Set<number>(), score: 0, max: 0, correct: 0, attempts: 0, lastAttemptedAt: attempt.attemptedAt,
    };
    row.attemptedIds.add(attempt.questionId);
    row.score += attempt.score ?? (attempt.isCorrect ? 1 : 0);
    row.max += attempt.maxScore ?? Math.max(1, attempt.question.marks);
    row.correct += attempt.isCorrect ? 1 : 0;
    row.attempts += 1;
    if (attempt.attemptedAt > row.lastAttemptedAt) row.lastAttemptedAt = attempt.attemptedAt;
    progress.set(key, row);
  }

  const mastery = catalog.map((row) => {
    const learned = progress.get(`${row.subject}::${row.topic}`);
    const total = Number(row.total);
    const attempted = learned?.attemptedIds.size ?? 0;
    return {
      subject: row.subject,
      subjectCode: row.subjectCode,
      topic: row.topic,
      totalQuestions: total,
      attemptedQuestions: attempted,
      coverage: total > 0 ? Math.min(100, Math.round((attempted / total) * 100)) : 0,
      mastery: learned && learned.max > 0 ? Math.round((learned.score / learned.max) * 100) : null,
      accuracy: learned && learned.attempts > 0 ? Math.round((learned.correct / learned.attempts) * 100) : null,
      attempts: learned?.attempts ?? 0,
      lastAttemptedAt: learned?.lastAttemptedAt ?? null,
    };
  });

  const weakTopics = mastery
    .filter((topic) => topic.attempts > 0)
    .sort((a, b) => (a.mastery ?? 0) - (b.mastery ?? 0) || b.attempts - a.attempts)
    .slice(0, 5);
  const attemptedQuestionIds = [...new Set(attempts.map((attempt) => attempt.questionId))];
  const candidates = weakTopics.length > 0
    ? await prisma.pastPaperQuestion.findMany({
        where: {
          docType: 'qp',
          marks: { gt: 0 },
          topic: { in: weakTopics.map((topic) => topic.topic) },
          ...(codeFilter ? { paper: { subject: { code: codeFilter } } } : {}),
          ...(attemptedQuestionIds.length ? { id: { notIn: attemptedQuestionIds } } : {}),
        },
        select: {
          id: true,
          content: true,
          topic: true,
          marks: true,
          number: true,
          part: true,
          subPart: true,
          paper: {
            select: { year: true, session: true, paperNumber: true, variant: true, subject: true },
          },
        },
        orderBy: { id: 'desc' },
        take: 80,
      })
    : [];

  const dueReviews = reviews.filter((review) => review.status === 'active' && review.nextReviewAt <= now);
  const adaptiveQueue = [
    ...dueReviews.filter((review) => review.questionId).slice(0, 3).map((review) => ({
      questionId: review.questionId!,
      subject: review.subject,
      topic: review.topic,
      title: review.prompt,
      reason: 'Spaced review due',
      kind: 'review',
    })),
    ...candidates
      .filter((candidate) => weakTopics.some((topic) => topic.topic === candidate.topic && topic.subject === candidate.paper.subject.name))
      .slice(0, 7)
      .map((candidate) => ({
        questionId: candidate.id,
        subject: candidate.paper.subject.name,
        topic: candidate.topic,
        title: plainText(candidate.content, 180),
        reason: `Build ${candidate.topic} mastery`,
        kind: 'practice',
        marks: candidate.marks,
        code: questionCode(candidate),
      })),
  ].filter((item, index, items) => items.findIndex((other) => other.questionId === item.questionId) === index).slice(0, 10);

  const todayTasks = tasks.filter((task) => task.dueAt >= startOfDay(now));
  const overdueTasks = tasks.filter((task) => task.dueAt < startOfDay(now));
  const subjects = [...new Set(mastery.map((topic) => topic.subject))];

  return NextResponse.json({
    profile,
    todayTasks,
    overdueTasks,
    dueReviews: dueReviews.length,
    reviewQueue: dueReviews.slice(0, 20),
    mistakes,
    mastery,
    adaptiveQueue,
    subjects,
    latestExam,
    scope: courseScope,
    summary: {
      topicsStarted: mastery.filter((topic) => topic.attempts > 0).length,
      topicsMastered: mastery.filter((topic) => (topic.mastery ?? 0) >= 80 && topic.attempts >= 3).length,
      tasksDue: tasks.length,
      activeReviews: reviews.filter((review) => review.status === 'active').length,
    },
  });
}

function questionCode(question: {
  number: number;
  part: string;
  subPart: string;
  paper: { year: number; session: string; paperNumber: number; variant: number; subject: { code: string } };
}) {
  const suffix = `${question.part || ''}${question.subPart || ''}`;
  return `${question.paper.subject.code}-${question.paper.session}${String(question.paper.year).slice(-2)}-P${question.paper.paperNumber}${question.paper.variant || ''}-Q${question.number}${suffix}`;
}
