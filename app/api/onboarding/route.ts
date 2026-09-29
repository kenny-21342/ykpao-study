import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { ensureCourseCatalog } from '@/lib/course-catalog';
import { CoursePreferenceFields } from '@/lib/course-preferences';

export const dynamic = 'force-dynamic';

/**
 * GET /api/onboarding
 *   Returns { onboarded, courses: [...] } for the signed-in user.
 *   `courses` is the catalog the user can pick subjects from.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await ensureCourseCatalog();
  const [freshUser, courses, enrollments] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { onboardedAt: true, tourCompletedAt: true } }),
    prisma.course.findMany({
      where: { OR: [{ catalogManaged: true }, { users: { some: { userId: user.id } } }] },
      include: { curriculumScopes: true },
      orderBy: [{ level: 'asc' }, { subject: 'asc' }],
    }),
    prisma.userCourse.findMany({ where: { userId: user.id } }),
  ]);

  return NextResponse.json({
    onboarded: freshUser?.onboardedAt != null,
    // The shell shows the guided tour when the student is onboarded but has
    // not yet finished or dismissed it. Accounts that predate the feature were
    // stamped by 20260929160000_user_tour_completed, so this is false for them.
    tourCompleted: freshUser?.tourCompletedAt != null,
    enrolledCourseIds: enrollments.map((e) => e.courseId),
    enrollments,
    courses: courses.map((c) => ({
      id: c.id,
      name: c.name,
      code: c.code,
      subject: c.subject,
      level: c.level,
      description: c.description,
      scopes: c.curriculumScopes,
      mapped: c.curriculumScopes.length > 0,
    })),
  });
}

const Body = z.object({
  courseIds: z.array(z.string()).optional(),
  courses: z.array(z.object({
    courseId: z.string().min(1),
    targetGrade: CoursePreferenceFields.targetGrade,
    examDate: CoursePreferenceFields.examDate,
  })).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  /**
   * Dismiss onboarding without picking anything.
   *
   * The wizard's close button used to call its `onComplete` callback directly,
   * which only hides the modal client-side. `onboardedAt` stayed null, so the
   * wizard reappeared on every single page load, forever, with no way to stop
   * it short of completing it. Skipping has to be a decision the server
   * records, and it cannot reuse the normal path below because that one
   * requires at least one subject.
   */
  skip: z.literal(true).optional(),
  /**
   * Mark the post-onboarding tour finished or dismissed. Sent on its own, and
   * deliberately separate from `skip`: a student who skips subject selection
   * should still be shown around, and one who finishes the tour must not have
   * their enrollments touched.
   */
  tourCompleted: z.literal(true).optional(),
});

/**
 * POST /api/onboarding
 *   Enrolls the user in controlled catalog courses and marks onboarding complete.
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request' },
      { status: 400 }
    );
  }

  const { courseIds = [], courses = [], name, skip, tourCompleted } = parsed;

  // Stamped on its own, before the skip and enrollment paths, so finishing the
  // tour never implies anything about subject selection either way.
  if (tourCompleted) {
    await prisma.user.update({
      where: { id: user.id },
      data: { tourCompletedAt: new Date() },
    });
    return NextResponse.json({ ok: true, tourCompleted: true });
  }

  // Skipping stamps `onboardedAt` and touches nothing else: no enrollments are
  // created and none are removed, so a user who skips keeps whatever they
  // already had and simply stops being asked.
  if (skip) {
    await prisma.user.update({
      where: { id: user.id },
      data: { onboardedAt: new Date() },
    });
    return NextResponse.json({ ok: true, skipped: true });
  }

  const preferences: Array<{ courseId: string; targetGrade?: string | null; examDate?: string | null }> = courses.length > 0
    ? courses
    : courseIds.map((courseId) => ({ courseId }));

  if (preferences.length === 0) {
    return NextResponse.json({ error: 'Pick at least one subject' }, { status: 400 });
  }

  await ensureCourseCatalog();
  const finalCourseIds = [...new Set(preferences.map((preference) => preference.courseId))];
  const valid = await prisma.course.findMany({
    where: { id: { in: finalCourseIds }, OR: [{ catalogManaged: true }, { users: { some: { userId: user.id } } }] },
    select: { id: true },
  });

  if (valid.length !== finalCourseIds.length) {
    return NextResponse.json({ error: 'No valid subjects selected' }, { status: 400 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.userCourse.deleteMany({ where: { userId: user.id, courseId: { notIn: finalCourseIds } } });
    for (const preference of preferences) {
      await tx.userCourse.upsert({
        where: { userId_courseId: { userId: user.id, courseId: preference.courseId } },
        create: {
          userId: user.id,
          courseId: preference.courseId,
          targetGrade: preference.targetGrade ?? null,
          examDate: preference.examDate ? new Date(`${preference.examDate}T12:00:00.000Z`) : null,
        },
        update: {
          targetGrade: preference.targetGrade ?? null,
          examDate: preference.examDate ? new Date(`${preference.examDate}T12:00:00.000Z`) : null,
        },
      });
    }
    await tx.user.update({
      where: { id: user.id },
      data: {
        onboardedAt: new Date(),
        ...(name ? { name } : {}),
      },
    });
  });

  return NextResponse.json({ ok: true, enrolledCount: finalCourseIds.length });
}
