import { prisma } from '@/lib/prisma';

export type ContextProvenance =
  | 'explicit-chat-course'
  | 'current-page-course'
  | 'legacy-subject-code'
  | 'conversation-course'
  | 'prompt-course-match'
  | 'sole-enrollment'
  | 'official-attempts'
  | 'review-history'
  | 'study-task'
  | 'default';

export type ContextSignal<T> = {
  value: T;
  confidence: number;
  provenance: ContextProvenance;
};

export type LearnerCourse = {
  id: string;
  name: string;
  code: string;
  subject: string;
  level: string;
  scopes: Array<{
    board: string;
    qualification: string;
    level: string;
    subjectCode: string;
  }>;
  targetGrade: string | null;
  examDate: Date | null;
  currentLevel: string | null;
  recentResult: string | null;
  personalizationEnabled: boolean;
  mapped: boolean;
};

export type MasteryTopic = {
  courseId: string;
  subjectCode: string;
  topic: string;
  mastery: number | null;
  accuracy: number | null;
  attempts: number;
  lastAttemptedAt: Date | null;
  confidence: number;
  provenance: ContextProvenance;
};

export type LearnerContext = {
  enrolledCourses: LearnerCourse[];
  activeCourse: LearnerCourse | null;
  activeCourseSignal: ContextSignal<string> | null;
  contextResolution: 'resolved' | 'clarification' | 'unrestricted' | 'unmapped';
  clarificationRequired: boolean;
  eligibleCourses: Array<Pick<LearnerCourse, 'id' | 'name' | 'subject' | 'level'>>;
  mastery: MasteryTopic[];
  weakTopics: MasteryTopic[];
  recurringWeaknesses: Array<{ topic: string; count: number; confidence: number; provenance: ContextProvenance }>;
  overdueReviews: Array<{ subject: string; topic: string; dueAt: Date; confidence: number; provenance: ContextProvenance }>;
  pendingTasks: Array<{ subject: string; topic: string; dueAt: Date; title: string; confidence: number; provenance: ContextProvenance }>;
  recentAttempts: Array<{ subjectCode: string; topic: string; score: number | null; maxScore: number | null; attemptedAt: Date; confidence: number; provenance: ContextProvenance }>;
  queryRewrite: ContextSignal<string> | null;
  profile: {
    weeklyStudyMinutes: number;
    availability: unknown;
  } | null;
};

export class LearnerContextError extends Error {
  status = 400;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'LearnerContextError';
    this.status = status;
  }
}

type ResolverCourse = Pick<LearnerCourse, 'id' | 'name' | 'code' | 'subject' | 'level' | 'scopes'>;

export type CourseResolution = {
  activeCourse: ResolverCourse | null;
  signal: ContextSignal<string> | null;
  status: LearnerContext['contextResolution'];
  clarificationRequired: boolean;
  eligibleCourses: ResolverCourse[];
};

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchesPrompt(course: ResolverCourse, prompt: string) {
  const text = normalize(prompt);
  if (!text) return false;
  const exactCode = course.scopes.some((scope) => new RegExp(`(?:^|\\s)${scope.subjectCode}(?:$|\\s)`, 'i').test(prompt));
  if (exactCode || text.includes(normalize(course.code))) return true;
  const subject = normalize(course.subject);
  const name = normalize(course.name);
  if (subject.length >= 3 && new RegExp(`\\b${subject.replace(/ /g, '\\s+')}\\b`, 'i').test(text)) {
    if (name !== subject && name.length >= 3 && text.includes(name)) return true;
    return true;
  }
  if (name.length >= 3 && text.includes(name)) return true;
  return false;
}

function withCourse(
  courses: ResolverCourse[],
  id: string | null | undefined,
  provenance: ContextProvenance,
): CourseResolution | null {
  if (!id) return null;
  const course = courses.find((item) => item.id === id);
  if (!course) throw new LearnerContextError('That course is not one of your enrolled courses.', 403);
  return {
    activeCourse: course,
    signal: { value: course.id, confidence: 1, provenance },
    status: course.scopes.length > 0 ? 'resolved' : 'unmapped',
    clarificationRequired: false,
    eligibleCourses: [course],
  };
}

/** Pure precedence resolver, kept separate so it can be unit-tested without Prisma. */
export function resolveActiveCourse(input: {
  courses: ResolverCourse[];
  explicitCourseId?: string | null;
  pageCourseId?: string | null;
  pageSubjectCode?: string | null;
  conversationCourseId?: string | null;
  legacySubjectCode?: string | null;
  prompt?: string;
}): CourseResolution {
  const explicit = withCourse(input.courses, input.explicitCourseId, 'explicit-chat-course');
  if (explicit) return explicit;
  const page = withCourse(input.courses, input.pageCourseId, 'current-page-course');
  if (page) return page;

  const pageCode = input.pageSubjectCode || input.legacySubjectCode;
  if (pageCode) {
    const byCode = input.courses.filter((course) => course.scopes.some((scope) => scope.subjectCode.toLowerCase() === pageCode.toLowerCase()));
    if (byCode.length === 1) {
      return {
        activeCourse: byCode[0],
        signal: { value: byCode[0].id, confidence: 0.98, provenance: input.pageSubjectCode ? 'current-page-course' : 'legacy-subject-code' },
        status: byCode[0].scopes.length > 0 ? 'resolved' : 'unmapped',
        clarificationRequired: false,
        eligibleCourses: [byCode[0]],
      };
    }
    if (byCode.length > 1) {
      return { activeCourse: null, signal: null, status: 'clarification', clarificationRequired: true, eligibleCourses: byCode };
    }
  }

  // A learner may remove a course after a conversation was created. Treat the
  // stale conversation value as historical context, not as an authorized
  // active course; explicit client-supplied IDs still fail above.
  const conversation = input.conversationCourseId && input.courses.some((course) => course.id === input.conversationCourseId)
    ? withCourse(input.courses, input.conversationCourseId, 'conversation-course')
    : null;
  if (conversation) return conversation;

  const promptMatches = input.prompt ? input.courses.filter((course) => matchesPrompt(course, input.prompt!)) : [];
  if (promptMatches.length === 1) {
    return {
      activeCourse: promptMatches[0],
      signal: { value: promptMatches[0].id, confidence: 0.88, provenance: 'prompt-course-match' },
      status: promptMatches[0].scopes.length > 0 ? 'resolved' : 'unmapped',
      clarificationRequired: false,
      eligibleCourses: promptMatches,
    };
  }
  if (promptMatches.length > 1) {
    return { activeCourse: null, signal: null, status: 'clarification', clarificationRequired: true, eligibleCourses: promptMatches };
  }

  if (input.courses.length === 1) {
    return {
      activeCourse: input.courses[0],
      signal: { value: input.courses[0].id, confidence: 0.8, provenance: 'sole-enrollment' },
      status: input.courses[0].scopes.length > 0 ? 'resolved' : 'unmapped',
      clarificationRequired: false,
      eligibleCourses: input.courses,
    };
  }
  // Enrolled in several courses and the message named none of them.
  //
  // This is absence of a signal, not ambiguity between candidates, and the
  // difference matters: the branches above fire when the student said
  // something that matches two courses, where one short question resolves it.
  // This one fired for *anything else* -- so a student with twelve
  // enrolments was met by a wall of twelve buttons before the tutor would say
  // a word, including in reply to "Good morning". For a year group, that is
  // the first thing almost everyone would ever see it do.
  //
  // Answer unscoped instead. `eligibleCourses` is still returned, so the
  // client can offer the same courses as chips underneath a real answer; the
  // choice is then an refinement the student may take, rather than a toll
  // gate. Picking one is remembered for the conversation, so the offer stops
  // after it is used.
  if (input.courses.length > 1) {
    return { activeCourse: null, signal: null, status: 'unrestricted', clarificationRequired: false, eligibleCourses: input.courses };
  }
  return { activeCourse: null, signal: null, status: 'unrestricted', clarificationRequired: false, eligibleCourses: [] };
}

function courseForSubject(courses: LearnerCourse[], subject: string) {
  const value = normalize(subject);
  return courses.find((course) =>
    normalize(course.subject) === value || normalize(course.name) === value ||
    course.scopes.some((scope) => scope.subjectCode.toLowerCase() === value)
  );
}

function buildQueryRewrite(message: string, context: Pick<LearnerContext, 'activeCourse' | 'weakTopics' | 'overdueReviews' | 'pendingTasks' | 'recentAttempts'>): ContextSignal<string> | null {
  if (!context.activeCourse) return null;
  const lower = message.toLowerCase();
  const weak = context.weakTopics[0];
  if (/\b(my weakest topic|weakest topic|weakest area)\b/.test(lower) && weak) {
    return { value: `${message}. Focus on ${weak.topic} in ${context.activeCourse.name}.`, confidence: weak.confidence, provenance: 'official-attempts' };
  }
  if (/\bwhat should i study|what do i study|study today|next step\b/.test(lower)) {
    const due = context.pendingTasks[0] ?? context.overdueReviews[0];
    const focus = due ? `${due.topic} (${due.subject})` : weak?.topic ?? 'the next syllabus topic';
    return { value: `${message}. Prioritize ${focus} for ${context.activeCourse.name}${context.activeCourse.examDate ? ` before ${context.activeCourse.examDate.toISOString().slice(0, 10)}` : ''}.`, confidence: due ? 0.9 : weak ? weak.confidence : 0.55, provenance: due ? 'study-task' : 'official-attempts' };
  }
  if (/\bquiz me|practice me|question set\b/.test(lower)) {
    const focus = weak?.topic ?? 'core topics';
    const average = context.recentAttempts.length > 0
      ? context.recentAttempts.reduce((sum, attempt) => sum + ((attempt.score ?? 0) / Math.max(1, attempt.maxScore ?? 1)), 0) / context.recentAttempts.length
      : 0.5;
    const difficulty = average < 0.55 ? 'accessible foundational' : average > 0.8 ? 'stretch' : 'mixed';
    return { value: `${message}. Use ${difficulty} ${context.activeCourse.name} questions focused on ${focus}.`, confidence: 0.82, provenance: 'official-attempts' };
  }
  return null;
}

export async function getLearnerContext(input: {
  userId: string;
  explicitCourseId?: string | null;
  pageCourseId?: string | null;
  pageSubjectCode?: string | null;
  legacySubjectCode?: string | null;
  conversationId?: string | null;
  prompt?: string;
}): Promise<LearnerContext> {
  const [enrollments, profile, conversation] = await Promise.all([
    prisma.userCourse.findMany({
      where: { userId: input.userId },
      include: { course: { include: { curriculumScopes: true } } },
      orderBy: { enrolledAt: 'asc' },
    }),
    prisma.learningProfile.findUnique({ where: { userId: input.userId }, select: { weeklyStudyMinutes: true, availability: true } }),
    input.conversationId
      ? prisma.aIConversation.findFirst({ where: { id: input.conversationId, userId: input.userId, archived: false }, select: { courseId: true } })
      : Promise.resolve(null),
  ]);
  if (input.conversationId && !conversation) throw new LearnerContextError('Conversation not found.', 404);

  const courses: LearnerCourse[] = enrollments.map((enrollment) => ({
    id: enrollment.course.id,
    name: enrollment.course.name,
    code: enrollment.course.code,
    subject: enrollment.course.subject,
    level: enrollment.course.level,
    scopes: enrollment.course.curriculumScopes.map((scope) => ({ board: scope.board, qualification: scope.qualification, level: scope.level, subjectCode: scope.subjectCode })),
    targetGrade: enrollment.targetGrade,
    examDate: enrollment.examDate,
    currentLevel: enrollment.currentLevel,
    recentResult: enrollment.recentResult,
    personalizationEnabled: enrollment.personalizationEnabled,
    mapped: enrollment.course.curriculumScopes.length > 0,
  }));
  const resolution = resolveActiveCourse({
    courses,
    explicitCourseId: input.explicitCourseId,
    pageCourseId: input.pageCourseId,
    pageSubjectCode: input.pageSubjectCode,
    legacySubjectCode: input.legacySubjectCode,
    conversationCourseId: conversation?.courseId,
    prompt: input.prompt,
  });
  const activeCourse = resolution.activeCourse
    ? courses.find((course) => course.id === resolution.activeCourse!.id) ?? null
    : null;
  const activeId = activeCourse?.id;
  const activeCodes = new Set(activeCourse?.scopes.map((scope) => scope.subjectCode) ?? []);

  const mappedCodes = [...new Set(courses.flatMap((course) => course.scopes.map((scope) => scope.subjectCode)))];
  const [attempts, reviews, tasks] = await Promise.all([
    mappedCodes.length > 0 ? prisma.pastPaperAttempt.findMany({
      where: { userId: input.userId, gradingStatus: 'official', question: { paper: { subject: { code: { in: mappedCodes } } } } },
      orderBy: { attemptedAt: 'desc' }, take: 500,
      select: { score: true, maxScore: true, isCorrect: true, weaknesses: true, attemptedAt: true, question: { select: { topic: true, paper: { select: { subject: { select: { code: true, name: true } } } } } } },
    }) : Promise.resolve([]),
    prisma.reviewItem.findMany({ where: { userId: input.userId, status: 'active', nextReviewAt: { lte: new Date() } }, orderBy: { nextReviewAt: 'asc' }, take: 100, select: { subject: true, topic: true, nextReviewAt: true } }),
    prisma.studyTask.findMany({ where: { userId: input.userId, status: 'pending', dueAt: { lte: new Date(Date.now() + 14 * 86400000) } }, orderBy: { dueAt: 'asc' }, take: 100, select: { title: true, subject: true, topic: true, dueAt: true } }),
  ]);

  const masteryMap = new Map<string, { courseId: string; subjectCode: string; topic: string; score: number; max: number; correct: number; attempts: number; lastAttemptedAt: Date }>();
  const recentAttempts = attempts.filter((attempt) => !activeId || activeCodes.has(attempt.question.paper.subject.code)).slice(0, 20).map((attempt) => ({
    subjectCode: attempt.question.paper.subject.code,
    topic: attempt.question.topic || 'General',
    score: attempt.score,
    maxScore: attempt.maxScore,
    attemptedAt: attempt.attemptedAt,
    confidence: 0.9,
    provenance: 'official-attempts' as const,
  }));
  for (const attempt of attempts) {
    const subjectCode = attempt.question.paper.subject.code;
    const course = courses.find((candidate) => candidate.scopes.some((scope) => scope.subjectCode === subjectCode));
    if (!course) continue;
    const topic = attempt.question.topic || 'General';
    const key = `${course.id}:${subjectCode}:${topic}`;
    const row = masteryMap.get(key) ?? { courseId: course.id, subjectCode, topic, score: 0, max: 0, correct: 0, attempts: 0, lastAttemptedAt: attempt.attemptedAt };
    row.score += attempt.score ?? 0;
    row.max += attempt.maxScore ?? 1;
    row.correct += attempt.isCorrect ? 1 : 0;
    row.attempts += 1;
    if (attempt.attemptedAt > row.lastAttemptedAt) row.lastAttemptedAt = attempt.attemptedAt;
    masteryMap.set(key, row);
  }
  const mastery = [...masteryMap.values()].map((row) => ({
    courseId: row.courseId,
    subjectCode: row.subjectCode,
    topic: row.topic,
    mastery: row.max > 0 ? Math.round((row.score / row.max) * 100) : null,
    accuracy: row.attempts > 0 ? Math.round((row.correct / row.attempts) * 100) : null,
    attempts: row.attempts,
    lastAttemptedAt: row.lastAttemptedAt,
    confidence: Math.min(0.98, 0.55 + row.attempts * 0.06),
    provenance: 'official-attempts' as const,
  }));
  const weakTopics = mastery.filter((topic) => !activeId || topic.courseId === activeId).sort((a, b) => (a.mastery ?? 0) - (b.mastery ?? 0) || b.attempts - a.attempts).slice(0, 8);
  const weaknessCounts = new Map<string, number>();
  for (const attempt of attempts) {
    if (activeId && !activeCodes.has(attempt.question.paper.subject.code)) continue;
    if (attempt.isCorrect !== false) continue;
    const labels = attempt.weaknesses.length > 0 ? attempt.weaknesses : [attempt.question.topic || 'General'];
    for (const label of labels) weaknessCounts.set(label, (weaknessCounts.get(label) ?? 0) + 1);
  }
  const recurringWeaknesses = [...weaknessCounts.entries()].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([topic, count]) => ({ topic, count, confidence: Math.min(0.95, 0.5 + count * 0.08), provenance: 'official-attempts' as const }));
  const scoped = <T extends { subject: string }>(items: T[]) => items.filter((item) => !activeId || courseForSubject(courses.filter((course) => course.id === activeId), item.subject));
  const overdueReviews = scoped(reviews).map((review) => ({ subject: review.subject, topic: review.topic, dueAt: review.nextReviewAt, confidence: 0.85, provenance: 'review-history' as const }));
  const pendingTasks = scoped(tasks).map((task) => ({ title: task.title, subject: task.subject, topic: task.topic, dueAt: task.dueAt, confidence: 0.82, provenance: 'study-task' as const }));
  const base = {
    enrolledCourses: courses,
    activeCourse,
    activeCourseSignal: resolution.signal,
    contextResolution: resolution.status,
    clarificationRequired: resolution.clarificationRequired,
    eligibleCourses: resolution.eligibleCourses.map(({ id, name, subject, level }) => ({ id, name, subject, level })),
    mastery,
    weakTopics,
    recurringWeaknesses,
    overdueReviews,
    pendingTasks,
    recentAttempts,
    profile,
    queryRewrite: null as ContextSignal<string> | null,
  } satisfies Omit<LearnerContext, 'queryRewrite'> & { queryRewrite: ContextSignal<string> | null };
  return { ...base, queryRewrite: input.prompt ? buildQueryRewrite(input.prompt, base) : null };
}
