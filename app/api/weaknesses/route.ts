import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { parsePositiveInt } from '@/lib/query-params';

export const dynamic = 'force-dynamic';

type NormalizedAttempt = {
  source: 'past-paper' | 'mock-exam' | 'legacy-question';
  questionId: number | null;
  subject: string;
  topic: string;
  content: string;
  score: number | null;
  maxScore: number | null;
  isCorrect: boolean | null;
  attemptedAt: Date;
};

const MIRROR_WINDOW_MS = 5 * 60 * 1000;

function normalizeText(value: string | null | undefined) {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function attemptSignature(questionId: number, answer: string, score: number | null, isCorrect: boolean | null) {
  return `${questionId}::${normalizeText(answer)}::${score ?? ''}::${isCorrect ?? ''}`;
}

/**
 * GET /api/weaknesses
 *
 * Analyses the user's graded attempt history and returns:
 *   - per-topic accuracy (topics sorted worst-first)
 *   - per-subject accuracy
 *   - "recommended" question IDs from the user's weakest topics to practice
 *
 * Sources:
 *   - PastPaperAttempt rows from Questions Database practice
 *   - completed MockExamItem rows from submitted mock exams
 *   - legacy QuestionAttempt rows when they carry score/correctness data
 *
 * Query:
 *   ?limit=10    → number of recommended questions (default 10)
 *   ?subject=... → scope to a subject name
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = parsePositiveInt(searchParams.get('limit'), 10, 30);
  const subjectFilter = searchParams.get('subject');

  const [pastPaperAttempts, mockExamItems, legacyAttempts] = await Promise.all([
    prisma.pastPaperAttempt.findMany({
      where: { userId: user.id, gradingStatus: 'official' },
      select: {
        answer: true,
        score: true,
        maxScore: true,
        isCorrect: true,
        attemptedAt: true,
        questionId: true,
        question: {
          select: {
            id: true,
            topic: true,
            content: true,
            marks: true,
            paper: {
              select: {
                subject: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: { attemptedAt: 'desc' },
      take: 500,
    }),
    prisma.mockExamItem.findMany({
      where: {
        mockExam: { userId: user.id, status: 'completed' },
        gradingStatus: 'official',
      },
      select: {
        answer: true,
        score: true,
        isCorrect: true,
        attemptedAt: true,
        questionId: true,
        question: {
          select: {
            id: true,
            topic: true,
            content: true,
            marks: true,
            paper: {
              select: {
                subject: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: { attemptedAt: 'desc' },
      take: 500,
    }),
    prisma.questionAttempt.findMany({
      where: {
        userId: user.id,
        OR: [{ isCorrect: { not: null } }, { score: { not: null } }],
      },
      select: {
        score: true,
        isCorrect: true,
        attemptedAt: true,
        question: {
          select: {
            id: true,
            title: true,
            content: true,
            marks: true,
            topics: true,
            course: {
              select: {
                subject: true,
                name: true,
              },
            },
          },
        },
      },
      orderBy: { attemptedAt: 'desc' },
      take: 500,
    }),
  ]);

  const mirroredMockExamTimes = new Map<string, number[]>();
  for (const item of mockExamItems) {
    const question = item.question;
    if (!question) continue;
    const key = attemptSignature(question.id, item.answer ?? '', item.score ?? null, item.isCorrect ?? null);
    const times = mirroredMockExamTimes.get(key) ?? [];
    times.push(item.attemptedAt?.getTime() ?? 0);
    mirroredMockExamTimes.set(key, times);
  }

  const attempts: NormalizedAttempt[] = [];
  let pastPaperSourceCount = 0;
  let mockExamSourceCount = 0;
  let legacySourceCount = 0;

  for (const item of pastPaperAttempts) {
    const question = item.question;
    if (!question) continue;
    const subject = question.paper.subject.name ?? 'General';
    if (subjectFilter && subject !== subjectFilter) continue;
    const key = attemptSignature(question.id, item.answer ?? '', item.score ?? null, item.isCorrect ?? null);
    const itemTime = item.attemptedAt?.getTime() ?? 0;
    const isMirrored = (mirroredMockExamTimes.get(key) ?? []).some(
      (mockTime) => Math.abs(mockTime - itemTime) <= MIRROR_WINDOW_MS
    );
    if (isMirrored) continue;

    attempts.push({
      source: 'past-paper',
      questionId: question.id,
      subject,
      topic: question.topic || 'General',
      content: question.content,
      score: item.score ?? null,
      maxScore: item.maxScore ?? question.marks ?? null,
      isCorrect: item.isCorrect ?? null,
      attemptedAt: item.attemptedAt,
    });
    pastPaperSourceCount += 1;
  }

  for (const item of mockExamItems) {
    const question = item.question;
    if (!question) continue;
    const subject = question.paper.subject.name ?? 'General';
    if (subjectFilter && subject !== subjectFilter) continue;

    attempts.push({
      source: 'mock-exam',
      questionId: question.id,
      subject,
      topic: question.topic || 'General',
      content: question.content,
      score: item.score ?? null,
      maxScore: question.marks ?? null,
      isCorrect: item.isCorrect ?? null,
      attemptedAt: item.attemptedAt ?? new Date(),
    });
    mockExamSourceCount += 1;
  }

  for (const item of legacyAttempts) {
    const question = item.question;
    if (!question) continue;
    const subject = question.course.subject || question.course.name || 'General';
    if (subjectFilter && subject !== subjectFilter) continue;

    const topic = question.topics.find((entry) => entry.trim().length > 0) ?? question.title ?? 'General';
    const score = item.score ?? null;
    const maxScore = question.marks ?? null;
    const isCorrect = item.isCorrect ?? (score != null && maxScore != null ? score >= maxScore : null);
    if (isCorrect == null && (score == null || maxScore == null)) continue;

    attempts.push({
      source: 'legacy-question',
      questionId: null,
      subject,
      topic,
      content: question.content || question.title,
      score,
      maxScore: score == null ? null : maxScore,
      isCorrect,
      attemptedAt: item.attemptedAt,
    });
    legacySourceCount += 1;
  }

  if (attempts.length === 0) {
    return NextResponse.json({
      topics: [],
      subjects: [],
      recommended: [],
      message: 'Answer some questions or complete a mock exam to see your weaknesses.',
      sources: {
        pastPaper: 0,
        mockExams: 0,
        legacyQuestions: 0,
      },
    });
  }

  // ---- Aggregate by topic ----
  const topicMap = new Map<
    string,
    {
      subject: string;
      total: number;
      correct: number;
      scoreSum: number;
      maxSum: number;
    }
  >();

  for (const a of attempts) {
    const key = `${a.subject}::${a.topic}`;
    const entry =
      topicMap.get(key) ?? {
        subject: a.subject,
        total: 0,
        correct: 0,
        scoreSum: 0,
        maxSum: 0,
      };
    entry.total += 1;
    if (a.isCorrect) entry.correct += 1;
    if (typeof a.score === 'number') entry.scoreSum += a.score;
    if (typeof a.maxScore === 'number') entry.maxSum += a.maxScore;
    topicMap.set(key, entry);
  }

  const topics = Array.from(topicMap.entries())
    .map(([key, e]) => ({
      key,
      subject: e.subject,
      topic: key.split('::')[1] ?? 'General',
      total: e.total,
      correct: e.correct,
      accuracy: e.total > 0 ? Math.round((e.correct / e.total) * 100) : 0,
      mastery:
        e.maxSum > 0 ? Math.round((e.scoreSum / e.maxSum) * 100) : e.total > 0 ? Math.round((e.correct / e.total) * 100) : 0,
    }))
    .sort((a, b) => a.accuracy - b.accuracy); // worst first

  // ---- Aggregate by subject ----
  const subjectMap = new Map<string, { total: number; correct: number }>();
  for (const a of attempts) {
    const e = subjectMap.get(a.subject) ?? { total: 0, correct: 0 };
    e.total += 1;
    if (a.isCorrect) e.correct += 1;
    subjectMap.set(a.subject, e);
  }
  const subjects = Array.from(subjectMap.entries())
    .map(([subject, e]) => ({
      subject,
      total: e.total,
      correct: e.correct,
      accuracy: e.total > 0 ? Math.round((e.correct / e.total) * 100) : 0,
    }))
    .sort((a, b) => a.accuracy - b.accuracy);

  // ---- Recommend questions from the weakest topics ----
  // Pick the 3 weakest topics (with at least 3 attempts for reliability),
  // then find fresh questions the user hasn't attempted yet in those topics.
  const weakTopics = topics.filter((t) => t.total >= 3).slice(0, 3);
  const weakTopicNames = weakTopics.map((t) => t.topic);
  const weakSubjectNames = weakTopics.map((t) => t.subject);

  // Questions already attempted by this user (to avoid re-recommending).
  const attemptedIds = new Set(
    attempts
      .map((a) => a.questionId)
      .filter((questionId): questionId is number => typeof questionId === 'number')
  );

  let recommended: Array<{
    id: number;
    topic: string;
    subject: string;
    content: string;
    marks: number;
  }> = [];

  if (weakTopicNames.length > 0) {
    const candidates = await prisma.pastPaperQuestion.findMany({
      where: {
        docType: 'qp',
        topic: { in: weakTopicNames },
        paper: {
          subject: { name: { in: weakSubjectNames } },
        },
        marks: { gt: 0 },
      },
      take: 100,
      orderBy: { id: 'desc' },
      select: {
        id: true,
        topic: true,
        content: true,
        marks: true,
        paper: { select: { subject: { select: { name: true } } } },
      },
    });

    // Prefer questions the user hasn't tried.
    recommended = candidates
      .filter((q) => !attemptedIds.has(q.id))
      .slice(0, limit)
      .map((q) => ({
        id: q.id,
        topic: q.topic,
        subject: q.paper.subject.name,
        content: q.content.slice(0, 200),
        marks: q.marks,
      }));

    // If we still need more, include questions they got wrong before.
    if (recommended.length < limit) {
      const wrongQuestions = attempts
        .filter((a) => a.isCorrect === false && weakTopicNames.includes(a.topic))
        .slice(0, limit - recommended.length)
        .map((a) =>
          a.questionId == null
            ? null
            : {
                id: a.questionId,
                topic: a.topic,
                subject: a.subject,
                content: a.content.slice(0, 200),
                marks: a.maxScore ?? 0,
              }
        )
        .filter((item): item is { id: number; topic: string; subject: string; content: string; marks: number } => item !== null);
      recommended = [...recommended, ...wrongQuestions];
    }
  }

  return NextResponse.json({
    topics,
    subjects,
    recommended: recommended.slice(0, limit),
    totalAttempts: attempts.length,
    sources: {
      pastPaper: pastPaperSourceCount,
      mockExams: mockExamSourceCount,
      legacyQuestions: legacySourceCount,
    },
  });
}
