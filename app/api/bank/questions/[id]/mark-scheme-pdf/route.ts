import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUser } from '@/lib/auth';
import { reportError } from '@/lib/error-reporting';
import { parseEntityId } from '@/lib/query-params';

export const dynamic = 'force-dynamic';

/** Bank papers store the absolute path they were extracted from; the catalogue stores it relative to pdf_extraction/. */
function catalogPath(sourcePath: string): string {
  const marker = '/pdf_extraction/';
  const at = sourcePath.indexOf(marker);
  return at >= 0 ? sourcePath.slice(at + marker.length) : sourcePath;
}

/**
 * GET /api/bank/questions/:id/mark-scheme-pdf
 *
 * Opens the official mark scheme PDF for the sitting this question came from,
 * in the past-paper viewer with its mark-scheme tab active.
 *
 * Resolved from the question's own source file, not from the per-question
 * mark-scheme link, so it is right even where that link is wrong or missing:
 * the question paper's file finds its sitting in the catalogue, and the
 * sitting's `ms` document is the answer. If the question paper is not in the
 * catalogue, the bank's mark-scheme paper for the same sitting is tried.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const questionId = parseEntityId((await params).id);
  if (questionId === null) return NextResponse.json({ error: 'Invalid question id' }, { status: 400 });

  try {
    const question = await prisma.bankQuestion.findUnique({
      where: { id: questionId },
      select: {
        paper: {
          select: {
            subjectId: true, board: true, year: true, session: true,
            paperNumber: true, variant: true, timezone: true, sourcePath: true,
          },
        },
      },
    });
    if (!question) return NextResponse.json({ error: 'Question not found' }, { status: 404 });
    const paper = question.paper;

    let markSchemeId: number | null = null;

    const source = await prisma.pastPaper.findUnique({
      where: { filepath: catalogPath(paper.sourcePath) },
      select: { subjectId: true, year: true, session: true, paperNumber: true, variant: true, level: true, timezone: true },
    });
    if (source) {
      const sibling = await prisma.pastPaper.findFirst({
        where: { ...source, docType: 'ms' },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      markSchemeId = sibling?.id ?? null;
    }

    if (markSchemeId === null) {
      const bankMarkScheme = await prisma.bankPaper.findFirst({
        where: {
          subjectId: paper.subjectId, board: paper.board, year: paper.year, session: paper.session,
          paperNumber: paper.paperNumber, variant: paper.variant, timezone: paper.timezone, docType: 'ms',
        },
        select: { sourcePath: true },
        orderBy: { id: 'asc' },
      });
      if (bankMarkScheme) {
        const file = await prisma.pastPaper.findUnique({
          where: { filepath: catalogPath(bankMarkScheme.sourcePath) },
          select: { id: true },
        });
        markSchemeId = file?.id ?? null;
      }
    }

    if (markSchemeId === null) {
      return NextResponse.json({ error: 'No mark scheme PDF is on file for this paper.' }, { status: 404 });
    }
    // Relative, so it is right behind the proxy whatever host the app sees.
    return new NextResponse(null, { status: 302, headers: { Location: `/papers/${markSchemeId}` } });
  } catch (error) {
    reportError(error, { routePath: '/api/bank/questions/[id]/mark-scheme-pdf', routeType: 'route', method: 'GET' });
    return NextResponse.json({ error: 'Could not find the mark scheme' }, { status: 500 });
  }
}
