import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { resolveCourseScope } from '@/lib/course-scope';
import { LearnerContextError } from '@/lib/learner-context';
import { parsePositiveInt } from '@/lib/query-params';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

// GET /api/mock-exams — list the signed-in user's mock exams
export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const page = parsePositiveInt(searchParams.get('page'), 1);
    const limit = parsePositiveInt(searchParams.get('limit'), 20, 50);
    const courseScope = await resolveCourseScope({ userId: user.id, scope: searchParams.get('scope'), courseId: searchParams.get('courseId') });
    const where = { userId: user.id, ...(courseScope.effectiveScope === 'enrolled' ? { subjectCode: { in: courseScope.subjectCodes } } : {}) };

    const [total, exams] = await Promise.all([
      prisma.mockExam.count({ where }),
      prisma.mockExam.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          _count: { select: { items: true } },
        },
      }),
    ]);

    return NextResponse.json({
      exams: exams.map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        subjectCode: e.subjectCode,
        durationMinutes: e.durationMinutes,
        totalMarks: e.totalMarks,
        difficulty: e.difficulty,
        topics: e.topics,
        status: e.status,
        // The card shows this in place of a Start button on a failed paper;
        // without it every failure read as the generic fallback message.
        generationError: e.generationError,
        score: e.score,
        questionCount: e._count.items,
        createdAt: e.createdAt,
        submittedAt: e.submittedAt,
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
      scope: courseScope,
    });
  } catch (error) {
    if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('Failed to list mock exams:', error);
    await reportError(error, { routePath: '/api/mock-exams', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list mock exams' },
      { status: 500 }
    );
  }
}
