import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

// POST /api/mock-exams/[id]/start
// Marks the exam as in_progress and records startedAt (idempotent).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;

    const exam = await prisma.mockExam.findFirst({
      where: { id, userId: user.id },
    });
    if (!exam) {
      return NextResponse.json({ error: 'Mock exam not found' }, { status: 404 });
    }

    // Only a paper that is ready may be started. Writing 'in_progress' over
    // 'generating' would race the background job that is still choosing the
    // questions -- whichever wrote last would win -- and starting a 'failed'
    // paper would present an empty exam as a real one.
    if (exam.status === 'generating') {
      return NextResponse.json(
        { error: 'This paper is still being prepared.' },
        { status: 409 },
      );
    }
    if (exam.status === 'failed') {
      return NextResponse.json(
        { error: exam.generationError ?? 'This paper could not be generated.' },
        { status: 409 },
      );
    }

    const updated = await prisma.mockExam.update({
      where: { id },
      data: {
        status: exam.status === 'completed' ? exam.status : 'in_progress',
        startedAt: exam.startedAt ?? new Date(),
      },
    });

    return NextResponse.json({
      status: updated.status,
      startedAt: updated.startedAt,
    });
  } catch (error) {
    console.error('Failed to start mock exam:', error);
    await reportError(error, { routePath: '/api/mock-exams/[id]/start', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to start mock exam' },
      { status: 500 }
    );
  }
}
