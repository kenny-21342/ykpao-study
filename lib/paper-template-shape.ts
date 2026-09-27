/**
 * The rules that turn measurements of real papers into a blueprint.
 *
 * Its own module, importing nothing, so the plain-node test runner can load it
 * -- `lib/paper-templates.ts` cannot be imported there because it pulls in
 * Prisma through the `@/lib` alias. The same split `lib/spend-cap.ts` uses,
 * and for the same reason: every rule here is a judgement worth testing
 * properly, and the query around it is not.
 */

/** One question's worth of the blueprint: where it sits and what it is worth. */
export type PaperSlot = { position: number; marks: number };

export type PaperTemplate = {
  subjectCode: string;
  level: string;
  paperNumber: number;
  /** How many real papers the shape was averaged over. Never below MIN_PAPERS. */
  papersObserved: number;
  questionCount: number;
  totalMarks: number;
  slots: PaperSlot[];
  /**
   * `mcq` papers are filled only with questions carrying an answer key, so a
   * generated Paper 1 marks itself the way the real one does. `structured`
   * papers take anything, since a written answer is graded rather than keyed.
   */
  style: 'mcq' | 'structured';
};

/**
 * Below this the "median" is one or two papers wearing a statistic's clothes.
 * 175 of 183 groups clear it, so the bar costs almost nothing.
 */
export const MIN_PAPERS = 3;

/**
 * A position has to appear in at least this share of the observed papers to
 * earn a slot.
 *
 * Without it the template stretches to the longest paper ever extracted.
 * Physics 0625 Paper 4 is the worked example: position 10 appears in 26 of ~68
 * papers and position 11 in two, so an unguarded template would generate an
 * eleven-question paper that no real sitting has looked like since the layout
 * changed. The median question count is the other half of the same guard.
 */
const POSITION_QUORUM = 0.5;

/** At or above this share of keyed questions, the paper is multiple choice. */
const MCQ_THRESHOLD = 0.8;

/** One row of the measurement: a position within one (level, paper number). */
export type TemplateRow = {
  level: string;
  paperNumber: number;
  position: number;
  /** Papers in this group, total. */
  papersObserved: number;
  /** Papers in this group in which this position appears at all. */
  positionSeen: number;
  /** Median questions per paper in this group. */
  medianQuestions: number;
  /** Median marks at this position, null when nothing there carries marks. */
  medianMarks: number | null;
  /** Median marks across the whole group, the per-position fallback. */
  groupMedianMarks: number | null;
  keyedFraction: number;
};

/**
 * Turn measurements into templates.
 *
 * Pure, and separated from the query for exactly that reason: every rule worth
 * arguing about is here, and the test feeds it recorded rows rather than
 * needing a database.
 */
export function derivePaperTemplates(subjectCode: string, rows: TemplateRow[]): PaperTemplate[] {
  const groups = new Map<string, TemplateRow[]>();
  for (const row of rows) {
    if (row.papersObserved < MIN_PAPERS) continue;
    // Paper 0 is not a paper. It is what the filename parser produces for a
    // document that carries no paper number, and the only group it reaches
    // MIN_PAPERS for is Art & Design 0400 -- a coursework subject with no
    // written paper at all, offered to students as "Paper 0, 6 marks".
    if (row.paperNumber < 1) continue;
    const key = `${row.level}\u0000${row.paperNumber}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(row); else groups.set(key, [row]);
  }

  const templates: PaperTemplate[] = [];
  for (const bucket of groups.values()) {
    const [first] = bucket;
    // The median question count caps the length; the quorum removes positions
    // that are rare even within that. Both are needed: the cap alone would
    // keep a position that only half the papers have, and the quorum alone
    // would let a consistently-long tail extend the paper.
    const length = Math.max(1, Math.round(first.medianQuestions));
    const slots = bucket
      .filter((row) => row.position <= length)
      .filter((row) => row.positionSeen >= row.papersObserved * POSITION_QUORUM)
      .sort((a, b) => a.position - b.position)
      // A position with no mark data anywhere takes the group's median rather
      // than being dropped: the question exists in every real paper, and a
      // hole in our extraction is not a hole in the exam.
      .map((row, index) => ({
        position: index + 1,
        marks: Math.max(1, Math.round(row.medianMarks ?? row.groupMedianMarks ?? 1)),
      }));
    if (slots.length === 0) continue;

    templates.push({
      subjectCode,
      level: first.level,
      paperNumber: first.paperNumber,
      papersObserved: first.papersObserved,
      questionCount: slots.length,
      totalMarks: slots.reduce((sum, slot) => sum + slot.marks, 0),
      slots,
      style: first.keyedFraction >= MCQ_THRESHOLD ? 'mcq' : 'structured',
    });
  }
  return templates.sort((a, b) => a.level.localeCompare(b.level) || a.paperNumber - b.paperNumber);
}

/**
 * Pick the template a request means.
 *
 * `paperNumber` names one exactly. Without it, the paper with the most marks
 * is the sensible default: it is the one a student means by "a mock exam",
 * where Paper 1 is usually a multiple-choice screen and Papers 5/6 are
 * practicals that do not transfer to a screen at all.
 */
// Generic so that a caller passing templates carrying the exam board's figures
// gets one back still carrying them; typing this to `PaperTemplate` dropped the
// `official` field on the way out, which is where the paper's real duration and
// name live.
export function chooseTemplate<T extends PaperTemplate>(
  templates: readonly T[],
  options: { level?: string | null; paperNumber?: number | null } = {},
): T | null {
  // Normalised on both sides because the two vocabularies were written years
  // apart: a course says "A Level", `bank_subjects` says "a-level", and an IB
  // course says "HL" to match. Comparing raw strings silently matched nothing
  // for every A-level subject, which the fallback below would then hide.
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = options.level ? norm(options.level) : null;
  const byLevel = wanted ? templates.filter((t) => norm(t.level) === wanted) : templates;
  const pool = byLevel.length > 0 ? byLevel : templates;
  if (pool.length === 0) return null;
  if (typeof options.paperNumber === 'number') {
    return pool.find((t) => t.paperNumber === options.paperNumber) ?? null;
  }
  return [...pool].sort((a, b) => b.totalMarks - a.totalMarks)[0];
}
