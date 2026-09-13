import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

/**
 * The numbers on the signed-out landing page.
 *
 * These are the first claims a stranger sees about the platform, so each one
 * has to survive being checked. Three of the five were previously wrong in a
 * way that flattered the product:
 *
 *  - `questions` counted `PastPaperQuestion`, the **legacy** 12.4k text corpus,
 *    and ignored the 66,756 published crop-first bank questions that are what
 *    students actually practise on. It undersold the corpus by a factor of
 *    five while naming the wrong thing.
 *  - `resources` added `sharedNote`, a table whose only writer was deleted with
 *    the community-notes feature. It can only ever count rows that predate the
 *    removal, and it trends to a number nothing can increase.
 *  - `subjects` and `pastPapers` counted the legacy catalogue for the same
 *    reason as `questions`.
 *
 * Every count below is now restricted to content a signed-in student can
 * actually reach: `published` bank questions only (the `needs_review` queue is
 * held back from browsing, so counting it would be a promise the app does not
 * keep), and subjects that have at least one such question.
 */
export async function GET() {
  try {
    const [questions, subjects, pastPapers, resources, mockExams] = await Promise.all([
      prisma.bankQuestion.count({ where: { status: 'published' } }),
      // Distinct syllabus codes, through papers. A `bank_subjects` row is
      // (board, code, level), so counting rows double-counts a syllabus taught
      // at two levels -- and disagrees with the figure `lib/feature-readiness.ts`
      // states on the same page. Going through papers also means a subject
      // whose every question is still in review is not counted as "covered".
      prisma.bankSubject
        .findMany({
          where: { papers: { some: { questions: { some: { status: 'published' } } } } },
          select: { code: true },
          distinct: ['code'],
        })
        .then((rows) => rows.length),
      prisma.bankPaper.count({ where: { docType: 'qp' } }),
      prisma.schoolResource.count(),
      prisma.mockExam.count(),
    ]);

    return NextResponse.json({ questions, subjects, pastPapers, resources, mockExams });
  } catch (error) {
    console.error('[platform-stats] error:', error);
    await reportError(error, { routePath: '/api/platform-stats', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch platform stats' },
      { status: 500 },
    );
  }
}
