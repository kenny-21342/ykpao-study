import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';
import { EXAM_ITEM_INCLUDE, normalizeExamItem } from '@/lib/mock-exam-items';
import { optionLettersFor } from '@/lib/bank-grading';
import { gradeForExam, progressToTarget, targetForSubject } from '@/lib/grade-boundaries';

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

    // A grade only means anything once the paper is submitted, and only when
    // real thresholds -- or an honestly-labelled estimate -- back it.
    const grade = exam.submittedAt
      ? await gradeForExam(async ({ board, subjectCodes }) => {
          try {
            return await prisma.gradeBoundary.findMany({
              where: { board, subjectCode: { in: subjectCodes } },
              select: {
                grade: true, minMark: true, totalMarks: true,
                source: true, year: true, session: true, paperNumber: true,
              },
              orderBy: { year: 'desc' },
              take: 200,
            });
          } catch {
            // The table is created by a hand-applied migration, so it can be
            // absent while this code is live. An estimate is better than a
            // result screen that fails to load.
            return [];
          }
        }, {
          subjectCode: exam.subjectCode,
          marks: exam.score,
          totalMarks: exam.totalMarks,
        })
      : null;

    /*
     * The same paper measured against what the student is aiming for.
     *
     * `gradeForExam` says what the score earned; this says what the target
     * would have taken, read from the same rows under the same rules so the
     * two can never disagree. Null whenever there is nothing honest to show:
     * no target set for the subject, a target that is not on the board's own
     * scale, or a paper that was never submitted.
     */
    const targetGrade = exam.subjectCode
      ? (await prisma.userCourse.findFirst({
          where: {
            userId: user.id,
            targetGrade: { not: null },
            course: { curriculumScopes: { some: { subjectCode: exam.subjectCode } } },
          },
          select: { targetGrade: true },
        }))?.targetGrade ?? null
      : null;

    const target = exam.submittedAt
      ? await targetForSubject(async ({ board, subjectCodes }) => {
          try {
            return await prisma.gradeBoundary.findMany({
              where: { board, subjectCode: { in: subjectCodes } },
              select: {
                grade: true, minMark: true, totalMarks: true,
                source: true, year: true, session: true, paperNumber: true,
              },
              orderBy: { year: 'desc' },
              take: 200,
            });
          } catch {
            return [];
          }
        }, { subjectCode: exam.subjectCode, targetGrade })
      : null;

    const targetProgress = target && exam.score != null
      ? progressToTarget({ marks: exam.score, totalMarks: exam.totalMarks, target })
      : null;

    return NextResponse.json({
      exam: {
        id: exam.id,
        grade,
        targetProgress,
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
                // The mark scheme is the worked answer to the question the
                // student is currently sitting. The results view is the only
                // thing that renders it, so it has no business being in the
                // payload before the paper is handed in.
                markschemeContent: exam.submittedAt ? normalized.markschemeContent : null,
                markschemeStrips: exam.submittedAt ? normalized.markschemeStrips : [],
                // The options the question offers, but not which one is right.
                // This route used to send `answerLetter` on every item whatever
                // the exam's status, so a student sitting a paper could read the
                // correct letter for every multiple-choice question straight out
                // of the network tab. The client only ever needed the option
                // count to draw the buttons, which is what this is.
                options: normalized.answerLetter
                  ? optionLettersFor(normalized.answerLetter)
                  : null,
                // The key itself is held back until the paper is handed in.
                answerLetter: exam.submittedAt ? normalized.answerLetter : null,
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
