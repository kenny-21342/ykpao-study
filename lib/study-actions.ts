import { prisma } from '@/lib/prisma';
import { addDays, endOfDay, plainText, startOfDay } from '@/lib/learning';
import { createPredictedPaper } from '@/lib/predicted-paper';

export type StudyActionType = 'study-week' | 'todo-plan' | 'daily-practice' | 'mock-exam' | 'predicted-paper' | 'materials';

export type FocusTopic = {
  subject: string;
  subjectCode?: string | null;
  topic: string;
  mastery: number;
  attempts: number;
};

export type StudyActionResult = {
  action: StudyActionType;
  summary: string;
  tasksCreated?: number;
  exam?: { id: string; title: string; subjectCode: string; questionCount: number; totalMarks: number };
  materials?: Array<{ id: string; type: 'resource' | 'note'; title: string; description: string; url: string }>;
  questions?: Array<{ id: number; title: string; topic: string; subject: string; url: string }>;
  focus: FocusTopic[];
};

type TodoFocus = FocusTopic & {
  dueAt: Date;
  taskId: string;
  sourceTitle: string;
};

export async function loadTodoContext(userId: string): Promise<{ focus: TodoFocus[]; summary: string; loadByDay: Map<number, number> }> {
  const [tasks, subjects] = await Promise.all([
    prisma.studyTask.findMany({
      where: { userId, status: 'pending', source: 'manual' },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      take: 60,
      select: {
        id: true,
        title: true,
        subject: true,
        topic: true,
        taskType: true,
        dueAt: true,
        durationMinutes: true,
      },
    }),
    prisma.subject.findMany({
      select: { code: true, name: true },
    }),
  ]);

  const subjectLookup = new Map<string, string>();
  for (const subject of subjects) {
    subjectLookup.set(subject.code.toLowerCase(), subject.code);
    subjectLookup.set(subject.name.toLowerCase(), subject.code);
  }

  const loadByDay = new Map<number, number>();
  const focus = tasks.map((task) => {
    const subjectCode = subjectLookup.get(task.subject.trim().toLowerCase()) ?? null;
    const day = new Date(task.dueAt).getDay();
    loadByDay.set(day, (loadByDay.get(day) ?? 0) + task.durationMinutes);
    return {
      taskId: task.id,
      sourceTitle: task.title,
      dueAt: task.dueAt,
      subject: task.subject,
      subjectCode,
      topic: task.topic,
      mastery: task.taskType === 'review' ? 45 : task.taskType === 'notes' ? 35 : 30,
      attempts: 1,
    };
  });

  const summary = tasks.length === 0
    ? 'No manual to-do items are pending.'
    : `${tasks.length} manual to-do item${tasks.length === 1 ? '' : 's'} are pending.`;

  return { focus, summary, loadByDay };
}

export function mergeFocus(primary: FocusTopic[], secondary: FocusTopic[]) {
  const merged: FocusTopic[] = [];
  const seen = new Set<string>();
  for (const item of [...secondary, ...primary]) {
    const key = `${item.subjectCode ?? item.subject}::${item.topic}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

export async function learningFocus(userId: string): Promise<FocusTopic[]> {
  const [attempts, enrollments] = await Promise.all([
    prisma.pastPaperAttempt.findMany({
      where: { userId, gradingStatus: 'official' },
      orderBy: { attemptedAt: 'desc' },
      take: 500,
      select: {
        score: true,
        maxScore: true,
        isCorrect: true,
        question: {
          select: { topic: true, marks: true, paper: { select: { subject: { select: { name: true, code: true } } } } },
        },
      },
    }),
    prisma.userCourse.findMany({
      where: { userId },
      select: { course: { select: { name: true, subject: true, code: true } } },
    }),
  ]);

  const grouped = new Map<string, { subject: string; subjectCode: string; topic: string; score: number; max: number; attempts: number }>();
  for (const attempt of attempts) {
    const subject = attempt.question.paper.subject;
    const topic = attempt.question.topic || 'General';
    const key = `${subject.code}::${topic}`;
    const row = grouped.get(key) ?? { subject: subject.name, subjectCode: subject.code, topic, score: 0, max: 0, attempts: 0 };
    row.score += attempt.score ?? (attempt.isCorrect ? 1 : 0);
    row.max += attempt.maxScore ?? Math.max(1, attempt.question.marks);
    row.attempts += 1;
    grouped.set(key, row);
  }

  const focus = [...grouped.values()]
    .map((row) => ({
      subject: row.subject,
      subjectCode: row.subjectCode,
      topic: row.topic,
      mastery: row.max > 0 ? Math.round((row.score / row.max) * 100) : 0,
      attempts: row.attempts,
    }))
    .sort((a, b) => a.mastery - b.mastery || b.attempts - a.attempts)
    .slice(0, 8);
  if (focus.length > 0) return focus;

  const availableSubjects = await prisma.subject.findMany({
    where: { papers: { some: { questions: { some: { docType: 'qp', marks: { gt: 0 } } } } } },
    select: { code: true, name: true },
  });
  for (const enrollment of enrollments) {
    const matched = availableSubjects.find((subject) => subject.code === enrollment.course.code);
    if (matched) focus.push({ subject: matched.name, subjectCode: matched.code, topic: 'General', mastery: 0, attempts: 0 });
  }
  if (focus.length === 0 && availableSubjects[0]) {
    focus.push({ subject: availableSubjects[0].name, subjectCode: availableSubjects[0].code, topic: 'General', mastery: 0, attempts: 0 });
  }
  return focus.slice(0, 6);
}

export async function candidateQuestions(userId: string, focus: FocusTopic[], subjectCode?: string, take = 80) {
  const chosenSubject = subjectCode || focus.find((item) => item.subjectCode)?.subjectCode;
  const attempted = await prisma.pastPaperAttempt.findMany({
    where: { userId, gradingStatus: 'official' }, select: { questionId: true }, orderBy: { attemptedAt: 'desc' }, take: 300,
  });
  const attemptedIds = [...new Set(attempted.map((row) => row.questionId))];
  const relevantTopics = focus
    .filter((item) => !chosenSubject || item.subjectCode === chosenSubject)
    .map((item) => item.topic)
    .filter((topic) => topic !== 'General');
  const baseWhere = {
    docType: 'qp',
    marks: { gt: 0 },
    ...(chosenSubject && { paper: { subject: { code: chosenSubject } } }),
    ...(attemptedIds.length > 0 && { id: { notIn: attemptedIds } }),
  };
  let questions = await prisma.pastPaperQuestion.findMany({
    where: { ...baseWhere, ...(relevantTopics.length > 0 && { topic: { in: relevantTopics } }) },
    include: { paper: { include: { subject: true } } },
    orderBy: [{ paper: { year: 'desc' } }, { marks: 'asc' }],
    take,
  });
  if (questions.length < 4) {
    questions = await prisma.pastPaperQuestion.findMany({
      where: {
        docType: 'qp',
        marks: { gt: 0 },
        ...(chosenSubject && { paper: { subject: { code: chosenSubject } } }),
      },
      include: { paper: { include: { subject: true } } },
      orderBy: [{ paper: { year: 'desc' } }, { marks: 'asc' }],
      take,
    });
  }
  return questions;
}

async function createFocusedMockExam(userId: string, focus: FocusTopic[], requestedSubjectCode?: string) {
  const questions = await candidateQuestions(userId, focus, requestedSubjectCode, 100);
  if (questions.length === 0) throw new Error('No eligible past-paper questions are available for a mock exam.');
  const subject = questions[0].paper.subject;
  const subjectFocus = focus.filter((item) => item.subjectCode === subject.code);
  const ranked = [...questions].sort((a, b) => {
    const aRank = subjectFocus.findIndex((item) => item.topic === a.topic);
    const bRank = subjectFocus.findIndex((item) => item.topic === b.topic);
    return (aRank < 0 ? 99 : aRank) - (bRank < 0 ? 99 : bRank) || b.paper.year - a.paper.year;
  });
  const selected: typeof ranked = [];
  let totalMarks = 0;
  for (const question of ranked) {
    if (selected.length >= 10 || (selected.length >= 5 && totalMarks >= 45)) break;
    selected.push(question);
    totalMarks += question.marks;
  }
  const topics = [...new Set(selected.map((question) => question.topic).filter((topic) => topic && topic !== 'General'))];
  const title = `${subject.name} Focus Mock`;
  const exam = await prisma.mockExam.create({
    data: {
      userId,
      title,
      description: `Automatically assembled from ${topics.length > 0 ? `priority topics: ${topics.join(', ')}` : 'recent past-paper questions'}.`,
      subjectCode: subject.code,
      durationMinutes: Math.max(30, Math.round(totalMarks * 1.5)),
      totalMarks,
      topics,
      difficulty: 'adaptive',
      items: {
        create: selected.map((question, order) => ({
          questionId: question.id,
          sectionTitle: question.topic && question.topic !== 'General' ? question.topic : 'Core questions',
          order,
        })),
      },
    },
  });
  return { id: exam.id, title: exam.title, subjectCode: subject.code, questionCount: selected.length, totalMarks };
}

export async function recommendMaterials(userId: string, focus: FocusTopic[]) {
  const terms = focus.slice(0, 5).flatMap((item) => [item.topic, item.subject]).filter((term) => term && term !== 'General');
  const filters = terms.slice(0, 8).flatMap((term) => [
    { title: { contains: term, mode: 'insensitive' as const } },
    { description: { contains: term, mode: 'insensitive' as const } },
    { subject: { contains: term, mode: 'insensitive' as const } },
  ]);
  const noteFilters = terms.slice(0, 8).flatMap((term) => [
    { title: { contains: term, mode: 'insensitive' as const } },
    { content: { contains: term, mode: 'insensitive' as const } },
  ]);
  const [resources, pages, notes] = await Promise.all([
    prisma.schoolResource.findMany({
      where: filters.length > 0 ? { OR: filters } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    prisma.page.findMany({
      where: {
        AND: [
          { OR: [{ section: { notebook: { userId } } }, { collaborators: { some: { userId } } }] },
          ...(noteFilters.length > 0 ? [{ OR: noteFilters }] : []),
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 4,
    }),
    prisma.note.findMany({
      where: {
        AND: [
          { OR: [{ userId }, { collaborators: { some: { userId } } }, { isPublic: true }] },
          ...(noteFilters.length > 0 ? [{ OR: noteFilters }] : []),
        ],
      },
      orderBy: { updatedAt: 'desc' },
      take: 4,
    }),
  ]);
  return [
    ...resources.map((resource) => ({
      id: resource.id,
      type: 'resource' as const,
      title: resource.title,
      description: plainText(resource.description || resource.fileName, 180),
      url: resource.fileUrl,
    })),
    ...pages.map((page) => ({
      id: page.id,
      type: 'note' as const,
      title: page.title,
      description: plainText(page.content, 180),
      url: '/?tab=notes-textbook',
    })),
    ...notes.map((note) => ({
      id: note.id,
      type: 'note' as const,
      title: note.title,
      description: plainText(note.content, 180),
      url: '/?tab=notes-textbook',
    })),
  ].slice(0, 10);
}

async function schedulePractice(userId: string, focus: FocusTopic[], days = 7) {
  const questions = await candidateQuestions(userId, focus, undefined, 100);
  const selected = questions.slice(0, days);
  const start = startOfDay();
  await prisma.studyTask.deleteMany({
    where: {
      userId,
      source: 'ai-daily-practice',
      status: 'pending',
      dueAt: { gte: start, lte: endOfDay(addDays(start, days - 1)) },
    },
  });
  const tasks = selected.map((question, index) => {
    const dueAt = addDays(start, index);
    dueAt.setHours(17, 0, 0, 0);
    return {
      userId,
      questionId: question.id,
      title: `Daily practice: ${question.topic || 'Core question'}`,
      subject: question.paper.subject.name,
      topic: question.topic || 'General',
      taskType: 'practice',
      source: 'ai-daily-practice',
      dueAt,
      durationMinutes: Math.max(15, Math.min(35, question.marks * 4)),
    };
  });
  if (tasks.length > 0) await prisma.studyTask.createMany({ data: tasks });
  return {
    count: tasks.length,
    questions: selected.map((question) => ({
      id: question.id,
      title: plainText(question.content, 100),
      topic: question.topic,
      subject: question.paper.subject.name,
      url: `/?tab=questions-db&qid=${question.id}`,
    })),
  };
}

async function buildStudyWeek(userId: string, focus: FocusTopic[], requestedSubjectCode?: string) {
  const [practice, materials, exam] = await Promise.all([
    schedulePractice(userId, focus),
    recommendMaterials(userId, focus),
    createFocusedMockExam(userId, focus, requestedSubjectCode),
  ]);
  const start = startOfDay();
  const reviewTasks = focus.slice(0, 4).map((item, index) => {
    const dueAt = addDays(start, Math.min(6, index * 2 + 1));
    dueAt.setHours(18, 0, 0, 0);
    return {
      userId,
      questionId: null,
      title: `Review notes: ${item.topic}`,
      subject: item.subject,
      topic: item.topic,
      taskType: 'notes',
      source: 'ai-study-week',
      dueAt,
      durationMinutes: 20,
    };
  });
  const mockDueAt = addDays(start, 6);
  mockDueAt.setHours(15, 0, 0, 0);
  await prisma.studyTask.deleteMany({
    where: { userId, source: 'ai-study-week', status: 'pending', dueAt: { gte: start, lte: endOfDay(addDays(start, 6)) } },
  });
  await prisma.studyTask.createMany({
    data: [
      ...reviewTasks,
      {
        userId,
        questionId: null,
        title: `Complete ${exam.title}`,
        subject: focus.find((item) => item.subjectCode === exam.subjectCode)?.subject || exam.subjectCode,
        topic: 'Weekly checkpoint',
        taskType: 'mock-exam',
        source: 'ai-study-week',
        dueAt: mockDueAt,
        durationMinutes: Math.max(30, Math.round(exam.totalMarks * 1.5)),
      },
    ],
  });
  return { practice, materials, exam, extraTasks: reviewTasks.length + 1 };
}

export async function runStudyAction(input: { userId: string; action: StudyActionType; subjectCode?: string }): Promise<StudyActionResult> {
  const focus = await learningFocus(input.userId);
  const todoContext = await loadTodoContext(input.userId);
  const combinedFocus = mergeFocus(focus, todoContext.focus);
  if (combinedFocus.length === 0) throw new Error('No enrolled subject, to-do item, or question-bank material is available yet.');

  const preferredSubjectCode = input.subjectCode || combinedFocus.find((item) => item.subjectCode)?.subjectCode || undefined;

  if (input.action === 'predicted-paper') {
    if (!preferredSubjectCode) throw new Error('Pick a subject before generating a predicted paper.');
    const predicted = await createPredictedPaper({
      userId: input.userId,
      subjectCode: preferredSubjectCode,
      title: 'Predicted practice paper',
      difficulty: 'mixed',
    });
    return {
      action: input.action,
      summary: `Created ${predicted.exam.title} with ${predicted.exam.questionCount} questions and ${predicted.exam.totalMarks} marks. ${todoContext.summary}`,
      exam: predicted.exam,
      focus: combinedFocus,
    };
  }

  if (input.action === 'mock-exam') {
    const exam = await createFocusedMockExam(input.userId, combinedFocus, preferredSubjectCode);
    return { action: input.action, summary: `Created ${exam.title} with ${exam.questionCount} questions and ${exam.totalMarks} marks. ${todoContext.summary}`, exam, focus: combinedFocus };
  }
  if (input.action === 'daily-practice') {
    const practice = await schedulePractice(input.userId, combinedFocus);
    return { action: input.action, summary: `Scheduled ${practice.count} daily practice questions in Study Coach. ${todoContext.summary}`, tasksCreated: practice.count, questions: practice.questions, focus: combinedFocus };
  }
  if (input.action === 'materials') {
    const materials = await recommendMaterials(input.userId, combinedFocus);
    return { action: input.action, summary: `Found ${materials.length} relevant notes and reading resources for your priority topics. ${todoContext.summary}`, materials, focus: combinedFocus };
  }

  const week = await buildStudyWeek(input.userId, combinedFocus, preferredSubjectCode);
  return {
    action: input.action,
    summary: `${input.action === 'todo-plan' ? 'Built a to-do-aware seven-day plan' : 'Built a seven-day plan'} with ${week.practice.count + week.extraTasks} tasks, a focused mock exam, and ${week.materials.length} reading suggestions. ${todoContext.summary}`,
    tasksCreated: week.practice.count + week.extraTasks,
    exam: week.exam,
    materials: week.materials,
    questions: week.practice.questions,
    focus: combinedFocus,
  };
}
