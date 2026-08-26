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
import { subjectNameForCode } from '@/lib/course-catalog';
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
  markScheme: { id: number; strips: BankStrip[]; answerLetter: string | null } | null;
  /**
   * Whether a transcription exists for this question.
   *
   * The crop-only corpus run produced 68,849 published questions at no model
   * cost, and every one of them has an empty `bodyMd`: the strips are the
   * question. Transcription is a separate, paid pass that fills `bodyMd` in
   * later, subject by subject.
   *
   * Everything that reasons over a question rather than displaying it — hints,
   * AI grading, search — needs that text and cannot work without it. So the
   * features are gated on this flag and hidden when it is false, rather than
   * offered and then failing on an empty prompt. As transcription lands, they
   * appear for the questions that have it, with no further change here.
   */
  hasText: boolean;
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

/**
 * What a student should see for a subject.
 *
 * Two problems, both visible the moment the index lists 6,406 papers.
 *
 * The pipeline stores CAIE subjects as "CAIE 0625": it parses filenames, and a
 * filename carries the syllabus code, not the subject. The course catalog maps
 * code to name, so that is resolved here rather than by rebuilding the corpus.
 * IB papers already carry a real name and keep it.
 *
 * And the same name covers several qualifications — Physics is both 0625 and
 * 9702, History is IGCSE and IB — so without the level the list shows repeated
 * identical entries with no way to tell them apart.
 */
function displaySubject(subject: {
  name: string;
  code: string;
  level: string | null;
  board: string;
}): string {
  const name = subjectNameForCode(subject.code) ?? subject.name;
  const qualification = qualificationLabel(subject.board, subject.level);
  return qualification ? `${name} (${qualification})` : name;
}

/** "igcse" and "HL" are how the pipeline stores it; neither is what to show. */
function qualificationLabel(board: string, level: string | null): string | null {
  if (board === 'IB') {
    if (level === 'HL' || level === 'SL') return `IB ${level}`;
    return 'IB';
  }
  if (level === 'igcse') return 'IGCSE';
  if (level === 'a-level') return 'A Level';
  return null;
}

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
    subject: displaySubject(paper.subject),
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
        hasText: question.bodyMd.trim().length > 0,
        strips: toStrips(question.strips),
        markScheme:
          question.markScheme && question.markScheme.status === 'published'
            ? {
                id: question.markScheme.id,
                strips: toStrips(question.markScheme.strips),
                // Multiple-choice keys are recovered from the text layer with
                // no rendering at all, so they have a letter and no strips.
                answerLetter: question.markScheme.answerLetter,
              }
            : null,
      }))
      // A question whose strips all failed to resolve has nothing to show.
      .filter((question) => question.strips.length > 0),
  };
}

/** Papers that actually have published questions, newest sitting first. */
export async function listBankPapers(limit = 100) {
  const papers = await prisma.bankPaper.findMany({
    where: { docType: 'qp', questions: { some: { status: 'published' } } },
    orderBy: [{ year: 'desc' }, { paperNumber: 'asc' }, { variant: 'asc' }],
    take: limit,
    select: {
      id: true,
      year: true,
      session: true,
      paperNumber: true,
      variant: true,
      subject: { select: { name: true, code: true, level: true, board: true } },
      _count: { select: { questions: true } },
    },
  });

  return papers.map((paper) => ({
    ...paper,
    subject: { ...paper.subject, name: displaySubject(paper.subject) },
  }));
}
