import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [
      questions,
      subjects,
      pastPapers,
      sharedNotes,
      schoolResources,
      mockExams,
    ] = await Promise.all([
      prisma.pastPaperQuestion.count({ where: { docType: 'qp' } }),
      prisma.subject.count({ where: { papers: { some: {} } } }),
      prisma.pastPaper.count({ where: { docType: 'qp' } }),
      prisma.sharedNote.count({ where: { visibility: 'public' } }),
      prisma.schoolResource.count(),
      prisma.mockExam.count(),
    ]);

    return NextResponse.json({
      questions,
      subjects,
      pastPapers,
      resources: sharedNotes + schoolResources,
      mockExams,
    });
  } catch (error) {
    console.error('[platform-stats] error:', error);
    await reportError(error, { routePath: '/api/platform-stats', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch platform stats' },
      { status: 500 },
    );
  }
}
