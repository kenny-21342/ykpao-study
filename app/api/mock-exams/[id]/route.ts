import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';
import { EXAM_ITEM_INCLUDE, normalizeExamItem } from '@/lib/mock-exam-items';

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
          include: EXAM_ITEM_INCLUDE,
        },
      },
    });

    if (!exam) {
      return NextResponse.json({ error: 'Mock exam not found' }, { status: 404 });
    }

    // A legacy item's mark scheme has to be found by matching the whole paper's
    // coordinates in the `ms` document; a bank item's is a direct relation, so
    // it needs no lookup at all. `normalizeExamItem` hides that difference.
    const normalizedItems = await Promise.all(
      exam.items.map(async (item) => {
        let legacyMarkscheme: string | null = null;
        if (item.question && item.question.paper.docType === 'qp') {
          const found = await prisma.pastPaperQuestion.findFirst({
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
          legacyMarkscheme = found?.content ?? null;
        }
        return { item, normalized: normalizeExamItem(item, legacyMarkscheme) };
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
        // An item that resolved to neither corpus is dropped rather than
        // rendered blank; the CHECK constraint should make that impossible.
        items: normalizedItems.flatMap(({ item, normalized }) =>
          normalized
            ? [{
                id: item.id,
                sectionTitle: item.sectionTitle,
                order: item.order,
                questionId: item.questionId,
                bankQuestionId: item.bankQuestionId,
                number: normalized.number,
                part: normalized.part,
                subPart: normalized.subPart,
                content: normalized.content,
                latex: normalized.latex,
                marks: normalized.marks,
                // Empty for a legacy item, populated for a crop: the client
                // renders whichever it gets.
                strips: normalized.strips,
                markschemeContent: normalized.markschemeContent,
                markschemeStrips: normalized.markschemeStrips,
                answerLetter: normalized.answerLetter,
                answer: item.answer,
                score: item.score,
                isCorrect: item.isCorrect,
                explanation: item.explanation,
                modelAnswer: item.modelAnswer,
                strengths: item.strengths,
                weaknesses: item.weaknesses,
                attemptedAt: item.attemptedAt,
              }]
            : []
        ),
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
