import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const courses = await prisma.course.findMany({
    where: { curriculumScopes: { none: {} } },
    include: { _count: { select: { users: true } } },
    orderBy: [{ users: { _count: 'desc' } }, { name: 'asc' }],
  });
  return NextResponse.json({
    unmappedCourses: courses.map((course) => ({
      id: course.id,
      code: course.code,
      name: course.name,
      subject: course.subject,
      level: course.level,
      enrolledLearners: course._count.users,
    })),
  });
}
