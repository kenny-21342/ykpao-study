/**
 * One shape for a mock-exam question, whichever corpus it came from.
 *
 * A paper's items point at one of two tables. Papers generated before the
 * switch carry a `PastPaperQuestion`, which is transcribed text; papers
 * generated since carry a `BankQuestion`, which is a crop -- `bodyMd` is empty
 * for all but the transcribed subjects, and the question a student reads is the
 * strip image. Rather than teach every consumer about both, they all read the
 * shape below and check `strips.length` to decide whether to render an image or
 * prose.
 *
 * The two `include` shapes needed to build it live here too, so the detail
 * route and the submit route cannot drift into selecting different columns.
 */
import { Prisma } from '@prisma/client';
import { bankAssetKey } from '@/lib/storage/keys';
import type { BankStrip } from '@/lib/bank-questions';

/** What every consumer of a mock-exam item sees, regardless of corpus. */
export type NormalizedExamItem = {
  /** Question number as printed on the paper. */
  number: number;
  part: string | null;
  subPart: string | null;
  /** Transcribed text. Empty for a crop-only bank question -- use `strips`. */
  content: string;
  latex: string | null;
  marks: number;
  /** The crop, in reading order. Empty for a legacy transcribed question. */
  strips: BankStrip[];
  /** The mark scheme as prose, when there is any. */
  markschemeContent: string | null;
  /** The mark scheme as crops, when there are any. */
  markschemeStrips: BankStrip[];
  /** MCQ key, when the mark scheme carries one. Enables free auto-marking. */
  answerLetter: string | null;
};

/** The `include` a mock-exam item needs for `normalizeExamItem` to work. */
export const EXAM_ITEM_INCLUDE = {
  question: { include: { paper: { include: { subject: true } } } },
  bankQuestion: {
    include: {
      paper: true,
      strips: { include: { asset: true }, orderBy: { ordering: 'asc' } },
      markScheme: {
        include: { strips: { include: { asset: true }, orderBy: { ordering: 'asc' } } },
      },
    },
  },
} satisfies Prisma.MockExamItemInclude;

type StripRow = {
  page: number;
  asset: { sha256: string; width: number | null; height: number | null };
};

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
 * Flatten either kind of item into the common shape.
 *
 * `legacyMarkscheme` is passed in rather than looked up here: finding a legacy
 * mark scheme means matching a whole paper's coordinates, which is a query the
 * caller already batches. A bank question needs no such lookup -- its mark
 * scheme is a direct relation, which is the whole point of the newer schema.
 */
export function normalizeExamItem(
  item: {
    question: {
      number: number;
      part: string | null;
      subPart: string | null;
      content: string;
      latex: string | null;
      marks: number;
    } | null;
    bankQuestion: {
      rootNumber: number;
      bodyMd: string;
      totalMarks: number | null;
      strips: StripRow[];
      markScheme: {
        answerMd: string;
        answerLetter: string | null;
        totalMarks: number | null;
        status: string;
        strips: StripRow[];
      } | null;
    } | null;
  },
  legacyMarkscheme: string | null = null,
): NormalizedExamItem | null {
  if (item.bankQuestion) {
    const bank = item.bankQuestion;
    // An unpublished mark scheme is not one we should show or mark against.
    const markScheme = bank.markScheme?.status === 'published' ? bank.markScheme : null;
    return {
      number: bank.rootNumber,
      part: null,
      subPart: null,
      content: bank.bodyMd,
      latex: null,
      // Marks live on the mark scheme for crop-first questions; the question's
      // own `totalMarks` is set for only a few dozen rows in the whole corpus.
      marks: markScheme?.totalMarks ?? bank.totalMarks ?? 0,
      strips: toStrips(bank.strips),
      markschemeContent: markScheme?.answerMd?.trim() ? markScheme.answerMd : null,
      markschemeStrips: markScheme ? toStrips(markScheme.strips) : [],
      answerLetter: markScheme?.answerLetter ?? null,
    };
  }

  if (item.question) {
    return {
      number: item.question.number,
      part: item.question.part,
      subPart: item.question.subPart,
      content: item.question.content,
      latex: item.question.latex,
      marks: item.question.marks,
      strips: [],
      markschemeContent: legacyMarkscheme,
      markschemeStrips: [],
      answerLetter: null,
    };
  }

  // The database CHECK constraint makes this unreachable, but an item that
  // somehow points at neither corpus must not take a whole paper down with it.
  return null;
}
