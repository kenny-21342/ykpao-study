import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getLearnerContext } from '@/lib/learner-context';
import { ensureCourseCatalog } from '@/lib/course-catalog';
import { CoursePreferenceFields, describeValidationError } from '@/lib/course-preferences';
import { boardForSubjectCode, thresholdForGrade } from '@/lib/grade-boundaries';
import { progressLabel, progressTowardTarget } from '@/lib/grade-progress';

export const dynamic = 'force-dynamic';

const CoursePreference = z.object({
  courseId: z.string().min(1).max(100),
  ...CoursePreferenceFields,
  personalizationEnabled: z.boolean().optional(),
});

const Body = z.object({ courses: z.array(CoursePreference).max(30) });

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  await ensureCourseCatalog();
  const [context, catalog] = await Promise.all([
    getLearnerContext({ userId: user.id }),
    prisma.course.findMany({
      where: { OR: [{ catalogManaged: true }, { users: { some: { userId: user.id } } }] },
      include: { curriculumScopes: true },
      orderBy: [{ level: 'asc' }, { subject: 'asc' }, { name: 'asc' }],
    }),
  ]);
  return NextResponse.json({ context, catalog, targets: await courseTargets(user.id, context) });
}

/**
 * Per-course progress toward the target grade, for the dashboard cards.
 *
 * Only courses that actually have a target produce an entry, so the card can
 * render nothing at all for the rest rather than a row of empty chips. Mock
 * exams are the only samples -- see `lib/grade-progress.ts` for why -- and are
 * matched to a course through its curriculum scopes, which is the same join
 * the rest of the app uses to go from a course to a syllabus code.
 */
async function courseTargets(
  userId: string,
  context: Awaited<ReturnType<typeof getLearnerContext>>,
): Promise<Record<string, { status: string; label: string; grade: string; requiredPercent: number; averagePercent: number | null; sampleCount: number }>> {
  const withTargets = context.enrolledCourses.filter((course) => course.targetGrade);
  if (withTargets.length === 0) return {};

  const subjectCodes = [...new Set(withTargets.flatMap((course) => course.scopes.map((scope) => scope.subjectCode)))];
  const bareCodes = [...new Set(subjectCodes.map((code) => code.replace(/^ib-/, '')))];

  const [exams, boundaries] = await Promise.all([
    prisma.mockExam.findMany({
      where: {
        userId,
        submittedAt: { not: null },
        score: { not: null },
        subjectCode: { in: [...subjectCodes, ...bareCodes] },
      },
      select: { subjectCode: true, score: true, totalMarks: true, submittedAt: true },
      orderBy: { submittedAt: 'desc' },
      take: 200,
    }),
    // Tolerant of a missing table for the same reason the mock-exam route is:
    // the boundaries migration is applied by hand.
    prisma.gradeBoundary.findMany({
      where: { subjectCode: { in: [...subjectCodes, ...bareCodes] } },
      select: {
        subjectCode: true, grade: true, minMark: true, totalMarks: true,
        source: true, year: true, session: true, paperNumber: true,
      },
      orderBy: { year: 'desc' },
      take: 2000,
    }).catch(() => []),
  ]);

  const result: Record<string, { status: string; label: string; grade: string; requiredPercent: number; averagePercent: number | null; sampleCount: number }> = {};
  for (const course of withTargets) {
    const codes = new Set(course.scopes.flatMap((scope) => [scope.subjectCode, scope.subjectCode.replace(/^ib-/, '')]));
    const primary = course.scopes[0]?.subjectCode;
    if (!primary) continue;
    const board = boardForSubjectCode(primary);
    if (!board) continue;

    const target = thresholdForGrade({
      grade: course.targetGrade as string,
      board,
      rows: boundaries.filter((row) => codes.has(row.subjectCode)),
    });
    const progress = progressTowardTarget({
      samples: exams
        .filter((exam) => exam.subjectCode && codes.has(exam.subjectCode))
        .map((exam) => ({ score: exam.score as number, totalMarks: exam.totalMarks, submittedAt: exam.submittedAt as Date })),
      target,
    });
    if (!progress) continue;
    result[course.id] = {
      status: progress.status,
      label: progressLabel(progress),
      grade: progress.target.grade,
      requiredPercent: progress.target.requiredPercent,
      averagePercent: progress.averagePercent,
      sampleCount: progress.sampleCount,
    };
  }
  return result;
}

/** Replace the learner's enrollment set without deleting any study history. */
export async function PUT(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (error) {
    // Never `error.message` on a ZodError: that is the serialised issue
    // array, and a student who left an exam date blank was shown the raw
    // regex for eight courses at once.
    return NextResponse.json({ error: describeValidationError(error) }, { status: 400 });
  }
  const ids = body.courses.map((course) => course.courseId);
  if (new Set(ids).size !== ids.length) return NextResponse.json({ error: 'A course can only be included once.' }, { status: 400 });

  await ensureCourseCatalog();
  const valid = ids.length > 0 ? await prisma.course.findMany({
    where: {
      id: { in: ids },
      OR: [{ catalogManaged: true }, { users: { some: { userId: user.id } } }],
    },
    select: { id: true },
  }) : [];
  if (valid.length !== ids.length) {
    return NextResponse.json({ error: 'One or more courses are not available in the catalog.' }, { status: 400 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.userCourse.deleteMany({
      where: { userId: user.id, ...(ids.length > 0 ? { courseId: { notIn: ids } } : {}) },
    });
    for (const preference of body.courses) {
      await tx.userCourse.upsert({
        where: { userId_courseId: { userId: user.id, courseId: preference.courseId } },
        create: {
          userId: user.id,
          courseId: preference.courseId,
          targetGrade: preference.targetGrade ?? null,
          examDate: preference.examDate ? new Date(`${preference.examDate}T12:00:00.000Z`) : null,
          currentLevel: preference.currentLevel ?? null,
          recentResult: preference.recentResult ?? null,
          personalizationEnabled: preference.personalizationEnabled ?? true,
        },
        update: {
          ...(preference.targetGrade !== undefined && { targetGrade: preference.targetGrade }),
          ...(preference.examDate !== undefined && { examDate: preference.examDate ? new Date(`${preference.examDate}T12:00:00.000Z`) : null }),
          ...(preference.currentLevel !== undefined && { currentLevel: preference.currentLevel }),
          ...(preference.recentResult !== undefined && { recentResult: preference.recentResult }),
          ...(preference.personalizationEnabled !== undefined && { personalizationEnabled: preference.personalizationEnabled }),
        },
      });
    }
  });
  const context = await getLearnerContext({ userId: user.id });
  return NextResponse.json({ ok: true, context });
}
