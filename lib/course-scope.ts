import { prisma } from '@/lib/prisma';
import { LearnerContextError } from '@/lib/learner-context';

export type CourseScope = {
  requestedScope: 'enrolled' | 'all';
  effectiveScope: 'enrolled' | 'all';
  courseId: string | null;
  courseIds: string[];
  courseCodes: string[];
  subjectCodes: string[];
  subjects: string[];
  onboardingRequired: boolean;
};

/** Resolve list/search preference filters without changing authorization. */
export async function resolveCourseScope(input: {
  userId?: string | null;
  scope?: string | null;
  courseId?: string | null;
}): Promise<CourseScope> {
  const requestedScope = input.scope === 'all' ? 'all' : 'enrolled';
  if (!input.userId) {
    if (input.courseId) throw new LearnerContextError('Sign in to select a course.', 401);
    return { requestedScope, effectiveScope: 'all', courseId: null, courseIds: [], courseCodes: [], subjectCodes: [], subjects: [], onboardingRequired: false };
  }
  const enrollments = await prisma.userCourse.findMany({
    where: { userId: input.userId, ...(input.courseId ? { courseId: input.courseId } : {}) },
    include: { course: { include: { curriculumScopes: true } } },
  });
  if (input.courseId && enrollments.length === 0) {
    throw new LearnerContextError('That course is not one of your enrolled courses.', 403);
  }
  if (requestedScope === 'all' && !input.courseId) {
    return { requestedScope, effectiveScope: 'all', courseId: null, courseIds: [], courseCodes: [], subjectCodes: [], subjects: [], onboardingRequired: false };
  }
  if (enrollments.length === 0) {
    return { requestedScope, effectiveScope: 'all', courseId: null, courseIds: [], courseCodes: [], subjectCodes: [], subjects: [], onboardingRequired: true };
  }
  return {
    requestedScope,
    effectiveScope: 'enrolled',
    courseId: input.courseId ?? null,
    courseIds: enrollments.map((enrollment) => enrollment.courseId),
    courseCodes: enrollments.map((enrollment) => enrollment.course.code),
    subjectCodes: [...new Set(enrollments.flatMap((enrollment) => enrollment.course.curriculumScopes.map((scope) => scope.subjectCode)))],
    subjects: [...new Set(enrollments.map((enrollment) => enrollment.course.subject))],
    onboardingRequired: false,
  };
}
