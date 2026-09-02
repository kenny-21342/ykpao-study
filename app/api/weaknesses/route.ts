import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { parsePositiveInt } from '@/lib/query-params';
import {
  analyticsSubjectName,
  bankSubjectCodesForNames,
  bankAnalyticsQuestionSelect,
  bankTopicName,
  type BankAnalyticsQuestion,
} from '@/lib/bank-analytics';

export const dynamic = 'force-dynamic';

type NormalizedAttempt = {
  source: 'past-paper' | 'mock-exam' | 'legacy-question' | 'bank-question';
  questionId: number | null;
  bankQuestionId: number | null;
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

  const [pastPaperAttempts, mockExamItems, bankAttempts, legacyAttempts] = await Promise.all([
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
        // Exams have been generated from the crop-first bank since
        // `mock_exam_items_from_bank`. Without this join every question on
        // such an exam was skipped by the `if (!question) continue` below, so
        // a completed mock exam taught the heatmap nothing.
        bankQuestion: { select: bankAnalyticsQuestionSelect },
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
    prisma.bankQuestionAttempt.findMany({
      // Practice in the bank. `isCorrect` is null for a free-response question
      // with no answer key -- answered but unmarked -- and those carry no
      // accuracy signal, so they stay out.
      where: { userId: user.id, isCorrect: { not: null } },
      select: {
        score: true,
        isCorrect: true,
        createdAt: true,
        question: { select: bankAnalyticsQuestionSelect },
      },
      orderBy: { createdAt: 'desc' },
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
  let bankSourceCount = 0;

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
      bankQuestionId: null,
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
    const bankQuestion = item.bankQuestion as BankAnalyticsQuestion | null;
    // Exactly one of the two is set, by the same constraint that gives the
    // bank its own attempt and bookmark tables.
    if (!question && !bankQuestion) continue;

    const subject = question
      ? question.paper.subject.name ?? 'General'
      : analyticsSubjectName(bankQuestion!.paper.subject);
    if (subjectFilter && subject !== subjectFilter) continue;

    attempts.push({
      source: 'mock-exam',
      questionId: question?.id ?? null,
      bankQuestionId: bankQuestion?.id ?? null,
      subject,
      topic: question ? question.topic || 'General' : bankTopicName(bankQuestion!),
      content: question ? question.content : bankQuestion!.bodyMd,
      score: item.score ?? null,
      maxScore: question ? question.marks ?? null : bankQuestion!.totalMarks ?? null,
      isCorrect: item.isCorrect ?? null,
      attemptedAt: item.attemptedAt ?? new Date(),
    });
    mockExamSourceCount += 1;
  }

  for (const item of bankAttempts) {
    const question = item.question as BankAnalyticsQuestion | null;
    if (!question) continue;
    const subject = analyticsSubjectName(question.paper.subject);
    if (subjectFilter && subject !== subjectFilter) continue;

    attempts.push({
      source: 'bank-question',
      questionId: null,
      bankQuestionId: question.id,
      subject,
      topic: bankTopicName(question),
      content: question.bodyMd,
      score: item.score ?? null,
      maxScore: question.totalMarks ?? null,
      isCorrect: item.isCorrect ?? null,
      attemptedAt: item.createdAt,
    });
    bankSourceCount += 1;
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
      bankQuestionId: null,
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
        bankQuestions: 0,
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

  // Bank questions already attempted by this user (to avoid re-recommending).
  const attemptedBankIds = new Set(
    attempts
      .map((a) => a.bankQuestionId)
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
    // Recommend out of the crop-first bank: it is the corpus students browse,
    // and its questions render with their crops. The legacy table is still the
    // only source of a `topic` string, so until the syllabus registries are
    // loaded the topic filter below matches nothing and the subject-only
    // fallback is what actually runs.
    const bankSubjectCodes = bankSubjectCodesForNames(weakSubjectNames);
    const baseWhere = {
      status: 'published',
      totalMarks: { gt: 0 },
      paper: { subject: { code: { in: bankSubjectCodes } } },
    } as const;

    const select = {
      id: true,
      bodyMd: true,
      totalMarks: true,
      paper: { select: { subject: { select: { name: true, code: true } } } },
      topics: { select: { topic: { select: { name: true } } }, take: 1 },
      tags: { select: { tag: { select: { label: true } } }, take: 1 },
    } as const;

    let candidates = bankSubjectCodes.length === 0 ? [] : await prisma.bankQuestion.findMany({
      where: { ...baseWhere, topics: { some: { topic: { name: { in: weakTopicNames } } } } },
      take: 100,
      orderBy: { id: 'desc' },
      select,
    });

    // No topic rows for this subject yet, so widen to the subject. Once
    // `bank_question_topics` is populated the narrower query returns first and
    // this never runs.
    if (candidates.length === 0 && bankSubjectCodes.length > 0) {
      candidates = await prisma.bankQuestion.findMany({
        where: baseWhere,
        take: 100,
        orderBy: { id: 'desc' },
        select,
      });
    }

    // Prefer questions the user hasn't tried.
    recommended = candidates
      .filter((q) => !attemptedBankIds.has(q.id))
      .slice(0, limit)
      .map((q) => ({
        id: q.id,
        topic: q.topics[0]?.topic.name ?? q.tags[0]?.tag.label ?? 'General',
        subject: analyticsSubjectName(q.paper.subject),
        content: q.bodyMd.slice(0, 200),
        marks: q.totalMarks ?? 0,
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
      bankQuestions: bankSourceCount,
    },
  });
}
