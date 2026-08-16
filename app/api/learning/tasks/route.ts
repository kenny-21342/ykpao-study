import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { addDays, endOfDay, startOfDay } from '@/lib/learning';
import { loadTodoContext } from '@/lib/study-actions';
import { resolveCourseScope } from '@/lib/course-scope';
import { LearnerContextError } from '@/lib/learner-context';

export const dynamic = 'force-dynamic';

const ManualTask = z.object({
  title: z.string().trim().min(1).max(160),
  subject: z.string().trim().min(1).max(100),
  topic: z.string().trim().min(1).max(120),
  taskType: z.enum(['practice', 'review', 'notes', 'mock-exam']).default('practice'),
  dueAt: z.string().datetime(),
  durationMinutes: z.number().int().min(5).max(240),
  questionId: z.number().int().positive().nullable().optional(),
});

const UpdateTask = z.object({
  id: z.string().min(1),
  status: z.enum(['pending', 'completed', 'skipped']).optional(),
  dueAt: z.string().datetime().optional(),
  durationMinutes: z.number().int().min(5).max(240).optional(),
});

type Priority = { subject: string; topic: string; mastery: number; attempts: number };

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const from = searchParams.get('from') ? new Date(searchParams.get('from')!) : startOfDay();
  const to = searchParams.get('to') ? new Date(searchParams.get('to')!) : endOfDay(addDays(new Date(), 13));
  const status = searchParams.get('status');
  let courseScope;
  try {
    courseScope = await resolveCourseScope({ userId: user.id, scope: searchParams.get('scope'), courseId: searchParams.get('courseId') });
  } catch (error) {
    if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }

  const tasks = await prisma.studyTask.findMany({
    where: {
      userId: user.id,
      dueAt: { gte: from, lte: to },
      ...(status ? { status } : {}),
      ...(courseScope.effectiveScope === 'enrolled' ? { subject: { in: courseScope.subjects } } : {}),
    },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
  });

  return NextResponse.json({ tasks });
}

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const raw = (await req.json()) as Record<string, unknown>;
  if (raw.action === 'generate') {
    return generatePlan(user.id);
  }

  let body: z.infer<typeof ManualTask>;
  try {
    body = ManualTask.parse(raw);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid task' },
      { status: 400 }
    );
  }

  if (body.questionId) {
    const question = await prisma.pastPaperQuestion.findUnique({ where: { id: body.questionId }, select: { id: true } });
    if (!question) return NextResponse.json({ error: 'Question not found' }, { status: 404 });
  }

  const task = await prisma.studyTask.create({
    data: {
      userId: user.id,
      ...body,
      questionId: body.questionId ?? null,
      dueAt: new Date(body.dueAt),
    },
  });
  return NextResponse.json({ task }, { status: 201 });
}

export async function PATCH(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof UpdateTask>;
  try {
    body = UpdateTask.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid task' }, { status: 400 });
  }

  const existing = await prisma.studyTask.findFirst({ where: { id: body.id, userId: user.id } });
  if (!existing) return NextResponse.json({ error: 'Task not found' }, { status: 404 });

  const task = await prisma.studyTask.update({
    where: { id: existing.id },
    data: {
      ...(body.status && {
        status: body.status,
        completedAt: body.status === 'completed' ? new Date() : null,
      }),
      ...(body.dueAt && { dueAt: new Date(body.dueAt) }),
      ...(body.durationMinutes && { durationMinutes: body.durationMinutes }),
    },
  });
  return NextResponse.json({ task });
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Task ID is required' }, { status: 400 });
  const result = await prisma.studyTask.deleteMany({ where: { id, userId: user.id } });
  if (result.count === 0) return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

async function generatePlan(userId: string) {
  const courseScope = await resolveCourseScope({ userId });
  const [profile, attempts, courses] = await Promise.all([
    prisma.learningProfile.upsert({
      where: { userId },
      create: { userId, availability: { 0: 45, 1: 45, 2: 45, 3: 45, 4: 45, 5: 60, 6: 60 } },
      update: {},
    }),
    prisma.pastPaperAttempt.findMany({
      where: { userId, gradingStatus: 'official' },
      orderBy: { attemptedAt: 'desc' },
      take: 400,
      select: {
        questionId: true,
        score: true,
        maxScore: true,
        isCorrect: true,
        question: {
          select: { topic: true, paper: { select: { subject: { select: { name: true } } } } },
        },
      },
    }),
    prisma.userCourse.findMany({
      where: { userId },
      select: { course: { select: { name: true, subject: true, curriculumScopes: { select: { subjectCode: true } } } } },
    }),
  ]);
  const todoContext = await loadTodoContext(userId);

  const grouped = new Map<string, { subject: string; topic: string; score: number; max: number; attempts: number }>();
  for (const attempt of attempts) {
    if (courseScope.effectiveScope === 'enrolled' && !courseScope.subjects.includes(attempt.question.paper.subject.name)) continue;
    const subject = attempt.question.paper.subject.name;
    const topic = attempt.question.topic || 'General';
    const key = `${subject}::${topic}`;
    const row = grouped.get(key) ?? { subject, topic, score: 0, max: 0, attempts: 0 };
    row.score += attempt.score ?? (attempt.isCorrect ? 1 : 0);
    row.max += attempt.maxScore ?? 1;
    row.attempts += 1;
    grouped.set(key, row);
  }

  const priorities: Priority[] = [...grouped.values()]
    .map((row) => ({
      subject: row.subject,
      topic: row.topic,
      mastery: row.max > 0 ? Math.round((row.score / row.max) * 100) : 0,
      attempts: row.attempts,
    }))
    .sort((a, b) => a.mastery - b.mastery || b.attempts - a.attempts);

  const todoPriorities: Priority[] = todoContext.focus
    .filter((item) => courseScope.effectiveScope === 'all' || courseScope.subjects.includes(item.subject))
    .map((item) => ({
    subject: item.subject,
    topic: item.topic,
    mastery: item.mastery,
    attempts: item.attempts,
  }));

  const seen = new Set<string>();
  const combinedPriorities = [...todoPriorities, ...priorities].filter((item) => {
    const key = `${item.subject}::${item.topic}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (combinedPriorities.length === 0) {
    for (const enrollment of courses) {
      combinedPriorities.push({
        subject: enrollment.course.name || enrollment.course.subject,
        topic: 'Foundations',
        mastery: 0,
        attempts: 0,
      });
    }
  }
  if (combinedPriorities.length === 0) {
    combinedPriorities.push({ subject: 'General', topic: 'Core skills', mastery: 0, attempts: 0 });
  }

  const focus = combinedPriorities.slice(0, 6);
  const attemptedIds = [...new Set(attempts.map((attempt) => attempt.questionId))];
  const candidateQuestions = await prisma.pastPaperQuestion.findMany({
    where: {
      docType: 'qp',
      marks: { gt: 0 },
      topic: { in: focus.map((item) => item.topic) },
      ...(courseScope.effectiveScope === 'enrolled' ? { paper: { subject: { code: { in: courseScope.subjectCodes } } } } : {}),
      ...(attemptedIds.length > 0 ? { id: { notIn: attemptedIds } } : {}),
    },
    select: {
      id: true,
      topic: true,
      paper: { select: { subject: { select: { name: true } } } },
    },
    take: 100,
    orderBy: { id: 'desc' },
  });

  const availability = profile.availability && typeof profile.availability === 'object'
    ? profile.availability as Record<string, number>
    : {};
  const targetMinutes = Math.max(60, profile.weeklyStudyMinutes);
  const configuredTotal = Object.values(availability).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const fallbackDaily = Math.max(15, Math.floor(targetMinutes / 7));
  const planStart = startOfDay();
  const tasks: Array<{
    userId: string;
    questionId: number | null;
    title: string;
    subject: string;
    topic: string;
    taskType: string;
    source: string;
    dueAt: Date;
    durationMinutes: number;
  }> = [];
  let allocated = 0;
  let priorityIndex = 0;

  for (let offset = 0; offset < 7 && allocated < targetMinutes; offset += 1) {
    const day = addDays(planStart, offset);
    const configured = Number(availability[String(day.getDay())]) || 0;
    let capacity = configuredTotal > 0 ? configured : fallbackDaily;
    const manualLoad = todoContext.loadByDay.get(day.getDay()) ?? 0;
    capacity = Math.max(0, capacity - manualLoad);
    capacity = Math.min(capacity, targetMinutes - allocated);

    while (capacity >= 15 && tasks.length < 21 && allocated < targetMinutes) {
      const duration = Math.min(30, capacity, targetMinutes - allocated);
      const priority = focus[priorityIndex % focus.length];
      const makeMock = tasks.length > 0 && (tasks.length + 1) % 7 === 0;
      const candidate = candidateQuestions.find((question) =>
        question.topic === priority.topic && question.paper.subject.name === priority.subject
      ) ?? candidateQuestions[priorityIndex % Math.max(1, candidateQuestions.length)];
      const dueAt = new Date(day);
      dueAt.setHours(17 + Math.min(3, tasks.filter((task) => task.dueAt.toDateString() === day.toDateString()).length), 0, 0, 0);

      tasks.push({
        userId,
        questionId: makeMock ? null : candidate?.id ?? null,
        title: makeMock ? `Timed checkpoint: ${priority.subject}` : `Practice ${priority.topic}`,
        subject: priority.subject,
        topic: priority.topic,
        taskType: makeMock ? 'mock-exam' : priority.mastery < 50 ? 'practice' : 'review',
        source: 'auto-plan',
        dueAt,
        durationMinutes: duration,
      });
      allocated += duration;
      capacity -= duration;
      priorityIndex += 1;
    }
  }

  await prisma.$transaction([
    prisma.studyTask.deleteMany({
      where: {
        userId,
        source: 'auto-plan',
        status: 'pending',
        dueAt: { gte: planStart, lte: endOfDay(addDays(planStart, 6)) },
      },
    }),
    prisma.studyTask.createMany({ data: tasks }),
  ]);

  const created = await prisma.studyTask.findMany({
    where: { userId, source: 'auto-plan', dueAt: { gte: planStart, lte: endOfDay(addDays(planStart, 6)) } },
    orderBy: { dueAt: 'asc' },
  });
  return NextResponse.json({ tasks: created, priorities: focus });
}
