import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { ensureCourseCatalog } from '@/lib/course-catalog';

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
    prisma.user.findUnique({ where: { id: user.id }, select: { onboardedAt: true } }),
    prisma.course.findMany({
      where: { OR: [{ catalogManaged: true }, { users: { some: { userId: user.id } } }] },
      include: { curriculumScopes: true },
      orderBy: [{ level: 'asc' }, { subject: 'asc' }],
    }),
    prisma.userCourse.findMany({ where: { userId: user.id } }),
  ]);

  return NextResponse.json({
    onboarded: freshUser?.onboardedAt != null,
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
    targetGrade: z.string().trim().max(20).nullable().optional(),
    examDate: z.string().date().nullable().optional(),
  })).optional(),
  name: z.string().trim().min(1).max(100).optional(),
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

  const { courseIds = [], courses = [], name } = parsed;
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
