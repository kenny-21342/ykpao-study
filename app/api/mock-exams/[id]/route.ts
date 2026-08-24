import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

// GET /api/mock-exams/[id] — fetch one exam with questions + items state
export async function GET(
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
      include: {
        items: {
          orderBy: { order: 'asc' },
          include: {
            question: {
              include: { paper: { include: { subject: true } } },
            },
          },
        },
      },
    });

    if (!exam) {
      return NextResponse.json({ error: 'Mock exam not found' }, { status: 404 });
    }

    // For each item, fetch the matching markscheme
    const itemsWithMarkschemes = await Promise.all(
      exam.items.map(async (item) => {
        let markscheme: { content: string } | null = null;
        if (item.question.paper.docType === 'qp') {
          markscheme = await prisma.pastPaperQuestion.findFirst({
            where: {
              paper: {
                subjectId: item.question.paper.subjectId,
                year: item.question.paper.year,
                session: item.question.paper.session,
                paperNumber: item.question.paper.paperNumber,
                variant: item.question.paper.variant,
                docType: 'ms',
              },
              number: item.question.number,
              part: item.question.part,
              subPart: item.question.subPart,
            },
            select: { content: true },
          });
        }
        return { ...item, markschemeContent: markscheme?.content ?? null };
      })
    );

    return NextResponse.json({
      exam: {
        id: exam.id,
        title: exam.title,
        description: exam.description,
        subjectCode: exam.subjectCode,
        durationMinutes: exam.durationMinutes,
        totalMarks: exam.totalMarks,
        difficulty: exam.difficulty,
        topics: exam.topics,
        status: exam.status,
        // The client polls this route while a paper is generating and shows
        // this when it fails. Leaving it out of the projection meant every
        // failure surfaced as the generic fallback message instead of the
        // reason the server actually recorded.
        generationError: exam.generationError,
        score: exam.score,
        startedAt: exam.startedAt,
        submittedAt: exam.submittedAt,
        createdAt: exam.createdAt,
        items: itemsWithMarkschemes.map((i) => ({
          id: i.id,
          sectionTitle: i.sectionTitle,
          order: i.order,
          questionId: i.questionId,
          number: i.question.number,
          part: i.question.part,
          subPart: i.question.subPart,
          content: i.question.content,
          latex: i.question.latex,
          marks: i.question.marks,
          markschemeContent: i.markschemeContent,
          answer: i.answer,
          score: i.score,
          isCorrect: i.isCorrect,
          explanation: i.explanation,
          modelAnswer: i.modelAnswer,
          strengths: i.strengths,
          weaknesses: i.weaknesses,
          attemptedAt: i.attemptedAt,
        })),
      },
    });
  } catch (error) {
    console.error('Failed to fetch mock exam:', error);
    await reportError(error, { routePath: '/api/mock-exams/[id]', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch mock exam' },
      { status: 500 }
    );
  }
}

// DELETE /api/mock-exams/[id] — delete a mock exam
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;

    const existing = await prisma.mockExam.findFirst({ where: { id, userId: user.id } });
    if (!existing) {
      return NextResponse.json({ error: 'Mock exam not found' }, { status: 404 });
    }

    await prisma.mockExam.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Failed to delete mock exam:', error);
    await reportError(error, { routePath: '/api/mock-exams/[id]', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete mock exam' },
      { status: 500 }
    );
  }
}
