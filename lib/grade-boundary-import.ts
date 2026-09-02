import { CAIE_GRADE_ORDER, IB_GRADE_ORDER, type GradeSource } from './grade-boundaries.ts';

/**
 * Parsing a grade-threshold table into rows.
 *
 * Boundaries arrive as a table, because that is how they are published and how
 * a school receives them: CAIE issues a grade threshold PDF per session, and IB
 * coordinators get their own per-session figures. Nothing here invents a
 * threshold -- an unparseable row is reported, not guessed at, because a
 * fabricated boundary would put a wrong predicted grade in front of a student
 * making a university decision.
 */

export type ParsedBoundary = {
  board: 'CAIE' | 'IB';
  subjectCode: string;
  level: string | null;
  year: number | null;
  session: string | null;
  paperNumber: number | null;
  grade: string;
  minMark: number;
  totalMarks: number;
  source: GradeSource;
};

export type ParseResult = {
  rows: ParsedBoundary[];
  errors: string[];
};

const REQUIRED = ['board', 'subjectcode', 'grade', 'minmark', 'totalmarks'] as const;

/**
 * Reads CSV with a header row. Columns, in any order:
 *
 *   board,subjectCode,level,year,session,paperNumber,grade,minMark,totalMarks
 *
 * `source` is not taken from the file: it is supplied by the caller, so an
 * uploader cannot label their own figures as officially published.
 */
export function parseGradeBoundaryCsv(csv: string, source: GradeSource): ParseResult {
  const errors: string[] = [];
  const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 2) {
    return { rows: [], errors: ['The file needs a header row and at least one row of thresholds.'] };
  }

  const header = splitRow(lines[0]).map((cell) => cell.toLowerCase());
  const missing = REQUIRED.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    return { rows: [], errors: [`Missing required column(s): ${missing.join(', ')}.`] };
  }

  const index = (name: string) => header.indexOf(name);
  const rows: ParsedBoundary[] = [];

  for (let line = 1; line < lines.length; line += 1) {
    const cells = splitRow(lines[line]);
    const at = (name: string) => {
      const position = index(name);
      return position === -1 ? '' : (cells[position] ?? '').trim();
    };
    const where = `Row ${line + 1}`;

    const board = at('board').toUpperCase();
    if (board !== 'CAIE' && board !== 'IB') {
      errors.push(`${where}: board must be CAIE or IB, got "${at('board')}".`);
      continue;
    }

    const subjectCode = at('subjectcode');
    if (!subjectCode) {
      errors.push(`${where}: subjectCode is required.`);
      continue;
    }

    // A grade has to belong to the board's own scale. This is the check that
    // stops a letter being filed against an IB subject, where it would be
    // silently ignored at lookup time and the student would get a fallback
    // estimate with no sign anything was wrong.
    const grade = at('grade').toUpperCase();
    const scale: readonly string[] = board === 'IB' ? IB_GRADE_ORDER : CAIE_GRADE_ORDER;
    if (!scale.includes(grade)) {
      errors.push(`${where}: "${at('grade')}" is not a ${board} grade (expected one of ${scale.join(', ')}).`);
      continue;
    }

    const minMark = toInt(at('minmark'));
    const totalMarks = toInt(at('totalmarks'));
    if (minMark === null || minMark < 0) {
      errors.push(`${where}: minMark must be a whole number, got "${at('minmark')}".`);
      continue;
    }
    if (totalMarks === null || totalMarks <= 0) {
      errors.push(`${where}: totalMarks must be a positive whole number, got "${at('totalmarks')}".`);
      continue;
    }
    if (minMark > totalMarks) {
      errors.push(`${where}: minMark ${minMark} is above totalMarks ${totalMarks}.`);
      continue;
    }

    rows.push({
      board,
      subjectCode,
      level: at('level') || null,
      year: toInt(at('year')),
      session: at('session') || null,
      paperNumber: toInt(at('papernumber')),
      grade,
      minMark,
      totalMarks,
      source,
    });
  }

  // A set of thresholds that goes the wrong way is a transcription error, and
  // it would silently award the wrong grade rather than fail.
  errors.push(...findNonMonotonicGroups(rows));

  return { rows, errors };
}

/** Within one paper, a better grade must need at least as many marks. */
function findNonMonotonicGroups(rows: ParsedBoundary[]): string[] {
  const groups = new Map<string, ParsedBoundary[]>();
  for (const row of rows) {
    const key = [row.board, row.subjectCode, row.level, row.year, row.session, row.paperNumber].join('|');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const problems: string[] = [];
  for (const [key, group] of groups) {
    const order: readonly string[] = group[0].board === 'IB' ? IB_GRADE_ORDER : CAIE_GRADE_ORDER;
    const ranked = [...group].sort((a, b) => order.indexOf(a.grade) - order.indexOf(b.grade));
    for (let i = 1; i < ranked.length; i += 1) {
      if (ranked[i].minMark > ranked[i - 1].minMark) {
        problems.push(
          `${key.replace(/\|/g, ' ')}: grade ${ranked[i].grade} needs ${ranked[i].minMark} marks, `
          + `more than ${ranked[i - 1].grade} at ${ranked[i - 1].minMark}. Thresholds are the wrong way round.`,
        );
        break;
      }
    }
  }
  return problems;
}

function toInt(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/** Minimal CSV: commas, with double-quoted cells allowed. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { cells.push(cell); cell = ''; }
    else cell += char;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}
