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

// ---------------------------------------------------------------------------
// Turning a target grade back into a mark.
//
// `gradeFromBoundaries` above answers "what did this score earn?". A target
// grade needs the inverse -- "what would this grade have taken?" -- which is
// what makes a target measurable instead of decorative. Both directions read
// the same rows under the same rules (newest session wins, compared
// proportionally), so the threshold a student is shown is the same line their
// grade was awarded against, and the two can never disagree.
// ---------------------------------------------------------------------------

export type GradeTarget = {
  /** The grade being aimed at, as stored. */
  grade: string;
  /** Proportion of the paper total required, 0-1. */
  required: number;
  /** That proportion as a percentage, rounded for display. */
  requiredPercent: number;
  source: GradeSource;
  scale: 'caie' | 'ib';
  isFallback: boolean;
};

/** Is this a grade on the board's own scale? Guards against "A" for an IB target. */
export function isGradeOnScale(grade: string, board: string): boolean {
  const order: readonly string[] = scaleForBoard(board) === 'ib' ? IB_GRADE_ORDER : CAIE_GRADE_ORDER;
  return order.includes(grade.trim().toUpperCase());
}

/**
 * The share of a paper a target grade requires.
 *
 * Returns null when the grade is not on the board's scale -- an IB student
 * whose stored target is "A" gets no threshold rather than a fabricated one,
 * because guessing which of 7..1 they meant is exactly the kind of invention
 * that makes a number untrustworthy.
 */
export function thresholdForGrade(input: {
  grade: string;
  board: string;
  rows: BoundaryRow[];
}): GradeTarget | null {
  const scale = scaleForBoard(input.board);
  const order: readonly string[] = scale === 'ib' ? IB_GRADE_ORDER : CAIE_GRADE_ORDER;
  const grade = input.grade.trim().toUpperCase();
  if (!order.includes(grade)) return null;

  const usable = input.rows.filter((row) => row.totalMarks > 0 && order.includes(row.grade));
  if (usable.length > 0) {
    // Same resolution as the forward direction: newest session on file.
    const newestYear = Math.max(...usable.map((row) => row.year ?? -1));
    const cohort = usable.filter((row) => (row.year ?? -1) === newestYear);
    const row = cohort.find((candidate) => candidate.grade === grade);
    if (row) {
      const required = row.minMark / row.totalMarks;
      return {
        grade,
        required,
        requiredPercent: Math.round(required * 100),
        source: normalizeSource(row.source),
        scale,
        isFallback: false,
      };
    }
    // Boundaries exist for this subject but not for this grade -- fall through
    // to the band rather than pretending the grade is unreachable.
  }

  const bands = scale === 'ib' ? IB_FALLBACK : CAIE_FALLBACK;
  const band = bands.find(([name]) => name === grade);
  if (!band) return null;
  return {
    grade,
    required: band[1] / 100,
    requiredPercent: band[1],
    source: 'estimate',
    scale,
    isFallback: true,
  };
}

export type TargetProgress = {
  target: GradeTarget;
  /** Marks needed on this paper to reach the target. */
  requiredMarks: number;
  /** Marks short of it; 0 once the target is met. */
  shortfall: number;
  met: boolean;
};

/**
 * How a score measures against a target, on one paper.
 *
 * `requiredMarks` is rounded up: a threshold of 61.2 marks is not reached by
 * 61, and telling a student they need "61" when 62 is the first mark that
 * awards the grade is the one rounding error that matters here.
 */
export function progressToTarget(input: {
  marks: number;
  totalMarks: number;
  target: GradeTarget;
}): TargetProgress | null {
  if (input.totalMarks <= 0) return null;
  const requiredMarks = Math.min(input.totalMarks, Math.ceil(input.target.required * input.totalMarks));
  const shortfall = Math.max(0, requiredMarks - input.marks);
  return { target: input.target, requiredMarks, shortfall, met: shortfall === 0 };
}

/**
 * The target threshold for a subject, from whatever thresholds are on file.
 *
 * Mirrors `gradeForExam`: takes a loader so this module stays free of database
 * types, and tolerates a missing table by falling back to the estimate bands.
 */
export async function targetForSubject(
  loadRows: (query: { board: 'CAIE' | 'IB'; subjectCodes: string[] }) => Promise<BoundaryRow[]>,
  input: { subjectCode: string | null; targetGrade: string | null },
): Promise<GradeTarget | null> {
  if (!input.targetGrade || !input.subjectCode) return null;
  const board = boardForSubjectCode(input.subjectCode);
  if (!board) return null;
  if (!isGradeOnScale(input.targetGrade, board)) return null;

  const rows = await loadRows({
    board,
    subjectCodes: [...new Set([input.subjectCode, input.subjectCode.replace(/^ib-/, '')])],
  });
  return thresholdForGrade({ grade: input.targetGrade, board, rows });
}
