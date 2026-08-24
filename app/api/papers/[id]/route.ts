import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUser } from '@/lib/auth';
import { reportError } from '@/lib/error-reporting';
import { parseEntityId } from '@/lib/query-params';
import {
  curriculumId,
  curriculumLabel,
  groupIntoInstances,
} from '@/lib/paper-catalogue';

export const dynamic = 'force-dynamic';

/**
 * One paper, together with every other document from the same sitting.
 *
 * The viewer needs the siblings to build its Question Paper / Mark Scheme /
 * Insert tabs, so they are resolved here in a single round trip.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  // `parseEntityId` also rejects values too large for the column: a finite
  // 1e20 passes Number.isInteger and then fails inside Prisma as a 500.
  const paperId = parseEntityId(id);
  if (paperId === null) {
    return NextResponse.json({ error: 'Invalid paper id' }, { status: 400 });
  }

  try {
    const paper = await prisma.pastPaper.findUnique({
      where: { id: paperId },
      select: {
        id: true,
        year: true,
        session: true,
        paperNumber: true,
        variant: true,
        level: true,
        timezone: true,
        docType: true,
        subject: { select: { code: true, name: true, board: true, qualification: true } },
      },
    });

    if (!paper) {
      return NextResponse.json({ error: 'Paper not found' }, { status: 404 });
    }

    const siblings = await prisma.pastPaper.findMany({
      where: {
        subject: { code: paper.subject.code },
        year: paper.year,
        session: paper.session,
        paperNumber: paper.paperNumber,
        variant: paper.variant,
        level: paper.level,
        timezone: paper.timezone,
      },
      select: {
        id: true,
        year: true,
        session: true,
        paperNumber: true,
        paperCode: true,
        variant: true,
        level: true,
        timezone: true,
        docType: true,
        filename: true,
        pageCount: true,
        sizeBytes: true,
        subject: { select: { code: true, name: true } },
      },
    });

    const [instance] = groupIntoInstances(siblings);
    if (!instance) {
      return NextResponse.json({ error: 'Paper not found' }, { status: 404 });
    }

    return NextResponse.json({
      paperId: paper.id,
      activeDocType: paper.docType,
      curriculum: {
        id: curriculumId(paper.subject.board, paper.subject.qualification),
        label: curriculumLabel(paper.subject.board, paper.subject.qualification),
      },
      instance,
    });
  } catch (error) {
    console.error('Failed to load paper:', error);
    await reportError(error, { routePath: '/api/papers/[id]', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load paper' },
      { status: 500 },
    );
  }
}
