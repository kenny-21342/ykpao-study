import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getLearnerContext } from '@/lib/learner-context';
import { ensureCourseCatalog } from '@/lib/course-catalog';

export const dynamic = 'force-dynamic';

const CoursePreference = z.object({
  courseId: z.string().min(1).max(100),
  targetGrade: z.string().trim().max(20).nullable().optional(),
  examDate: z.string().date().nullable().optional(),
  currentLevel: z.string().trim().max(80).nullable().optional(),
  recentResult: z.string().trim().max(120).nullable().optional(),
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
  return NextResponse.json({ context, catalog });
}

/** Replace the learner's enrollment set without deleting any study history. */
export async function PUT(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid courses' }, { status: 400 });
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
