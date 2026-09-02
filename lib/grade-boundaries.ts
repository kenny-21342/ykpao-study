import { COURSE_CATALOG } from './course-catalog-data.ts';

/**
 * Turning a mark into a grade.
 *
 * The mock-exam result screen computed this in the browser from a fixed
 * percentage ladder -- >=70 A, >=60 B, >=50 C, >=40 D, else E -- for every
 * subject on the platform. Two things are wrong with that. Real thresholds move
 * every session and sit well below 70% in most subjects, so the letter was
 * usually pessimistic. And it is a *letter*: every IB subject is graded 1-7, so
 * an IB student was told they got a "B" in a qualification that has no B.
 */

/** How much to trust the boundary a grade came from. */
export type GradeSource = 'published' | 'school' | 'estimate';

export type GradeResult = {
  grade: string;
  source: GradeSource;
  /** The scale the grade belongs to, for labelling. */
  scale: 'caie' | 'ib';
  /** True when nothing better than a generic band was available. */
  isFallback: boolean;
};

export type BoundaryRow = {
  grade: string;
  minMark: number;
  totalMarks: number;
  source: string;
  year: number | null;
  session: string | null;
  paperNumber: number | null;
};

/** Best to worst. A grade is awarded at the first boundary the mark reaches. */
export const CAIE_GRADE_ORDER = ['A*', 'A', 'B', 'C', 'D', 'E'] as const;
export const IB_GRADE_ORDER = ['7', '6', '5', '4', '3', '2', '1'] as const;

/**
 * Generic bands, used only when no real threshold is on file.
 *
 * These are deliberately not the old 70/60/50/40 ladder. CAIE A* sits nearer
 * 80% of a paper total and E nearer 30%; the IB 4 -- the pass -- is typically
 * around 40%. They are still estimates and are always reported as such.
 */
const CAIE_FALLBACK: Array<[string, number]> = [
  ['A*', 80], ['A', 70], ['B', 60], ['C', 50], ['D', 40], ['E', 30],
];
const IB_FALLBACK: Array<[string, number]> = [
  ['7', 80], ['6', 70], ['5', 58], ['4', 45], ['3', 32], ['2', 20], ['1', 0],
];

export function scaleForBoard(board: string): 'caie' | 'ib' {
  return board.toUpperCase() === 'IB' ? 'ib' : 'caie';
}

/**
 * The board a catalogue subject code belongs to.
 *
 * The bank stores IB subjects with and without an `ib-` prefix, and CAIE ones
 * as bare numeric syllabus codes.
 */
export function boardForSubjectCode(subjectCode: string): 'CAIE' | 'IB' | null {
  for (const entry of COURSE_CATALOG) {
    for (const scope of entry.scopes) {
      if (scope.subjectCode === subjectCode || scope.subjectCode === `ib-${subjectCode}`) {
        return scope.board === 'IB' ? 'IB' : 'CAIE';
      }
    }
  }
  if (subjectCode.startsWith('ib-')) return 'IB';
  return null;
}

/**
 * Pick the grade for a mark from a set of candidate boundary rows.
 *
 * Rows are expected to be for one subject. Resolution prefers the most recent
 * session on file, because a threshold from the session being revised for is
 * worth more than an average of every session ever sat.
 */
export function gradeFromBoundaries(input: {
  marks: number;
  totalMarks: number;
  board: string;
  rows: BoundaryRow[];
}): GradeResult {
  const scale = scaleForBoard(input.board);
  const order: readonly string[] = scale === 'ib' ? IB_GRADE_ORDER : CAIE_GRADE_ORDER;

  if (input.totalMarks <= 0) {
    return { grade: order[order.length - 1], source: 'estimate', scale, isFallback: true };
  }

  const usable = input.rows.filter((row) => row.totalMarks > 0 && order.includes(row.grade));
  if (usable.length > 0) {
    // Newest session wins; a row with no year is a subject-wide fallback and
    // sorts last.
    const newestYear = Math.max(...usable.map((row) => row.year ?? -1));
    const cohort = usable.filter((row) => (row.year ?? -1) === newestYear);

    // Boundaries are published against a paper total that rarely matches a
    // generated mock, so compare proportionally rather than by raw mark.
    const achieved = input.marks / input.totalMarks;
    for (const grade of order) {
      const row = cohort.find((candidate) => candidate.grade === grade);
      if (!row) continue;
      if (achieved >= row.minMark / row.totalMarks) {
        return {
          grade,
          source: normalizeSource(row.source),
          scale,
          isFallback: false,
        };
      }
    }
    // Below every boundary on file: the lowest grade on the scale.
    return {
      grade: order[order.length - 1],
      source: normalizeSource(cohort[0]?.source ?? 'estimate'),
      scale,
      isFallback: false,
    };
  }

  const percentage = (input.marks / input.totalMarks) * 100;
  const bands = scale === 'ib' ? IB_FALLBACK : CAIE_FALLBACK;
  const band = bands.find(([, floor]) => percentage >= floor);
  return {
    grade: band ? band[0] : order[order.length - 1],
    source: 'estimate',
    scale,
    isFallback: true,
  };
}

function normalizeSource(value: string): GradeSource {
  return value === 'published' || value === 'school' ? value : 'estimate';
}

/** Wording for the UI, so an estimate is never shown as a real threshold. */
export function gradeSourceLabel(result: GradeResult): string {
  if (result.source === 'published') return 'Official grade thresholds';
  if (result.source === 'school') return 'School grade boundaries';
  return result.isFallback
    ? 'Estimated — no grade boundaries on file for this subject'
    : 'Estimated grade boundaries';
}

/**
 * Resolve the grade for a finished paper from whatever thresholds are on file.
 *
 * Takes a loader rather than a Prisma client so this module stays free of
 * database types and can be unit-tested without one. Returns null when the
 * paper is not gradeable -- no subject, or nothing scored.
 *
 * The loader is expected to be forgiving: the `grade_boundaries` migration is
 * applied by hand here, so this code can reach production before the table
 * does, and a missing table must fall back to the estimate bands rather than
 * fail the whole result screen.
 */
export async function gradeForExam(
  loadRows: (query: { board: 'CAIE' | 'IB'; subjectCodes: string[] }) => Promise<BoundaryRow[]>,
  input: { subjectCode: string | null; marks: number | null; totalMarks: number },
): Promise<GradeResult | null> {
  if (input.marks == null || input.totalMarks <= 0 || !input.subjectCode) return null;
  const board = boardForSubjectCode(input.subjectCode);
  if (!board) return null;

  const rows = await loadRows({
    board,
    subjectCodes: [...new Set([input.subjectCode, input.subjectCode.replace(/^ib-/, '')])],
  });

  return gradeFromBoundaries({ marks: input.marks, totalMarks: input.totalMarks, board, rows });
}
