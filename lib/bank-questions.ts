/**
 * Reading the crop-first question bank.
 *
 * A bank question is an image, not text: the extraction pipeline renders the
 * original question as a series of strips, in reading order, with the answer
 * space and page furniture removed. `bodyMd` may be empty — a crop-only run
 * writes rows with no transcription at all — so nothing here depends on it.
 *
 * Strips matter rather than `screenshotId`: that column holds only the first
 * one, which for 89% of questions is the top fragment of the image.
 */
import { prisma } from '@/lib/prisma';
import { bankAssetKey } from '@/lib/storage/keys';

export type BankStrip = {
  url: string;
  width: number | null;
  height: number | null;
  page: number;
};

export type BankQuestionView = {
  id: number;
  rootNumber: number;
  totalMarks: number | null;
  pageStart: number | null;
  pageEnd: number | null;
  strips: BankStrip[];
  markScheme: { id: number; strips: BankStrip[] } | null;
};

export type BankPaperView = {
  id: number;
  subject: string;
  board: string;
  year: number;
  session: string;
  paperNumber: number;
  variant: number;
  questions: BankQuestionView[];
};

type StripRow = {
  page: number;
  asset: { sha256: string; width: number | null; height: number | null };
};

/**
 * Turn stored strip rows into servable URLs.
 *
 * A row whose sha256 is malformed is dropped rather than rendered as a broken
 * image: `bankAssetKey` returns null for anything that is not a digest.
 */
function toStrips(rows: StripRow[]): BankStrip[] {
  const strips: BankStrip[] = [];
  for (const row of rows) {
    const key = bankAssetKey(row.asset.sha256);
    if (!key) continue;
    strips.push({
      url: `/${key}`,
      width: row.asset.width,
      height: row.asset.height,
      page: row.page,
    });
  }
  return strips;
}

/**
 * One paper's questions, in order, each with its full crop.
 *
 * Only published rows are returned. A question sits at `needs_review` when the
 * crop QA found the image itself wrong — a cut-off question number, a missing
 * Marks column, an erased stem — and showing a student a known-bad crop is
 * worse than showing them nothing.
 */
export async function getBankPaper(paperId: number): Promise<BankPaperView | null> {
  const paper = await prisma.bankPaper.findUnique({
    where: { id: paperId },
    include: {
      subject: true,
      questions: {
        where: { status: 'published' },
        orderBy: { rootNumber: 'asc' },
        include: {
          strips: {
            orderBy: { ordering: 'asc' },
            include: { asset: { select: { sha256: true, width: true, height: true } } },
          },
          markScheme: {
            include: {
              strips: {
                orderBy: { ordering: 'asc' },
                include: { asset: { select: { sha256: true, width: true, height: true } } },
              },
            },
          },
        },
      },
    },
  });

  if (!paper) return null;

  return {
    id: paper.id,
    subject: paper.subject.name,
    board: paper.board,
    year: paper.year,
    session: paper.session,
    paperNumber: paper.paperNumber,
    variant: paper.variant,
    questions: paper.questions
      .map((question) => ({
        id: question.id,
        rootNumber: question.rootNumber,
        totalMarks: question.totalMarks,
        pageStart: question.pageStart,
        pageEnd: question.pageEnd,
        strips: toStrips(question.strips),
        markScheme:
          question.markScheme && question.markScheme.status === 'published'
            ? {
                id: question.markScheme.id,
                strips: toStrips(question.markScheme.strips),
              }
            : null,
      }))
      // A question whose strips all failed to resolve has nothing to show.
      .filter((question) => question.strips.length > 0),
  };
}

/** Papers that actually have published questions, newest sitting first. */
export async function listBankPapers(limit = 100) {
  return prisma.bankPaper.findMany({
    where: { docType: 'qp', questions: { some: { status: 'published' } } },
    orderBy: [{ year: 'desc' }, { paperNumber: 'asc' }, { variant: 'asc' }],
    take: limit,
    select: {
      id: true,
      year: true,
      session: true,
      paperNumber: true,
      variant: true,
      subject: { select: { name: true, code: true } },
      _count: { select: { questions: true } },
    },
  });
}
