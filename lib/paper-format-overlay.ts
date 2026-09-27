/**
 * Correcting a measured blueprint with the exam board's own figures.
 *
 * `lib/paper-template-shape.ts` measures what our extracted papers look like.
 * It is the only possible source for a per-question mark ladder -- no board
 * publishes one -- but it inherits every gap in the extraction, and the gaps
 * are not small. Measured against production on 27 Sep 2026, 160 of the 187
 * paper groups disagreed with the official total by more than a mark:
 *
 *   IB Maths AI HL Paper 1     official 110 marks, measured   7
 *   CAIE 9709 Pure Maths 1     official  75,       measured  42
 *   IGCSE 0470 Paper 4         official  40,       measured 520
 *
 * The last is the clearest argument for this module. Every question in IGCSE
 * History Paper 4 carries the paper's own 40-mark total, so thirteen questions
 * sum to 520, and a student who asks for a History mock gets a paper built to
 * 520 marks. The official figure is not a refinement here, it is the
 * difference between a paper and a nonsense.
 *
 * So: the board says how long the paper is, what it is called and what it is
 * worth; the corpus says how those marks are distributed across the questions.
 * Each is used only for what it alone can answer, which is the same division
 * the model picker draws between the gateway's model list and the status page.
 *
 * Pure and importing nothing, so the plain-node test runner can load it --
 * `lib/paper-formats.ts` is the half that reads the data files.
 */
import type { PaperSlot, PaperTemplate } from './paper-template-shape';

/** Where an official figure came from. Carried through to the UI, which says so. */
export type FormatSource = 'cambridge-syllabus' | 'ib-paper-cover';

export type OfficialFormat = {
  /** "Theory (Extended)", or null for the IB, which numbers papers without naming them. */
  name: string | null;
  /** Null where the board genuinely prints none: coursework, and every IB Language A paper. */
  minutes: number | null;
  marks: number;
  weightingPercent: number | null;
  source: FormatSource;
};

/**
 * No single question in these syllabuses is worth more than this.
 *
 * The cap is a credibility test on the *shape*, not on the total. Applying an
 * official total to a measured ladder assumes the ladder has roughly the right
 * number of rungs, and for a handful of subjects it does not: our extraction
 * merged every IB Maths AI Paper 1 into a single question, so measuring it
 * gives one position, and faithfully rescaling that to the official 110 marks
 * produces "one question, 110 marks" -- which is not a paper. It is worse than
 * the mark-total packing it replaced, because it looks deliberate.
 *
 * 40 is chosen to sit above the largest real question and below any merged
 * paper: IGCSE History Paper 4 genuinely is one question worth 40, and IB
 * Maths AA HL Paper 3 is two worth about 27 each, so both stay. A paper whose
 * slots exceed it is reporting an extraction failure, and the caller is told
 * so rather than handed the result.
 */
const MAX_CREDIBLE_SLOT_MARKS = 40;

/**
 * Nor is any whole paper worth more than this.
 *
 * The per-slot cap alone misses the other half of the IGCSE History bug: there
 * every question carries the paper's own 40-mark total, so each slot looks
 * plausible on its own and thirteen of them sum to 520. A subject we have no
 * official figure for keeps its measured total, so without this ceiling that
 * 520 would still reach a student.
 *
 * 200 sits above the longest paper either board sets -- IB Further Mathematics
 * HL Paper 1 is 150 marks, and no Cambridge paper here passes 100.
 */
const MAX_CREDIBLE_TOTAL_MARKS = 200;

/** A template that has been reconciled with the board's figures. */
export type OfficialPaperTemplate = PaperTemplate & {
  official: (OfficialFormat & {
    /**
     * True when the mark ladder was rescaled to reach the official total. The
     * UI needs it: a paper whose marks are the board's adds up to the number
     * printed on the real cover, and one whose marks are ours does not.
     */
    rescaled: boolean;
  }) | null;
  /**
   * False when the measured shape cannot carry the official total -- see
   * MAX_CREDIBLE_SLOT_MARKS. `loadPaperTemplates` drops these, so the subject
   * falls back to packing against a mark total, which is honest about having no
   * blueprint instead of inventing a one-question exam.
   */
  shapeCredible: boolean;
};

/**
 * Spread `total` over `slots` keeping their relative weights.
 *
 * Largest-remainder rather than rounding each slot independently, because
 * independent rounding does not sum to the total it was given -- and the total
 * is the one figure here that is definitely right. Every slot keeps at least
 * one mark, since a zero-mark question is not a question.
 */
function rescale(slots: readonly PaperSlot[], total: number): PaperSlot[] {
  const floor = slots.length;
  if (total <= floor) return slots.map((slot, i) => ({ position: i + 1, marks: 1 }));

  const weight = slots.reduce((sum, slot) => sum + Math.max(1, slot.marks), 0);
  const spare = total - floor;
  const exact = slots.map((slot) => (Math.max(1, slot.marks) / weight) * spare);
  const out = exact.map((value, i) => ({ position: i + 1, marks: 1 + Math.floor(value) }));

  // Hand the rounding loss to the slots that lost the most of it, so the marks
  // land on the heavier questions rather than on whichever came first.
  let short = total - out.reduce((sum, slot) => sum + slot.marks, 0);
  const order = exact
    .map((value, i) => ({ i, rem: value - Math.floor(value) }))
    .sort((a, b) => b.rem - a.rem);
  for (let k = 0; short > 0; k++, short--) out[order[k % order.length].i].marks += 1;
  return out;
}

/**
 * Apply the board's figures to one measured template.
 *
 * Multiple-choice papers are not rescaled, they are rebuilt: on both boards a
 * multiple-choice paper is one mark per question, so the official total *is*
 * the question count. Physics 0625 Paper 1 is 40 marks and 40 questions, and
 * IB Biology HL Paper 1 is 40 and 40. Measuring it gave 38 questions worth 9
 * marks between them, because a keyed question carries no mark of its own --
 * so here the official figure fixes the length as well as the weight.
 */
export function applyOfficialFormat(
  template: PaperTemplate,
  official: OfficialFormat | null,
): OfficialPaperTemplate {
  const credible = (t: PaperTemplate) =>
    t.slots.every((s) => s.marks <= MAX_CREDIBLE_SLOT_MARKS)
    && t.slots.reduce((sum, s) => sum + s.marks, 0) <= MAX_CREDIBLE_TOTAL_MARKS;
  if (!official) return { ...template, official: null, shapeCredible: credible(template) };

  if (template.style === 'mcq') {
    const slots = Array.from({ length: official.marks }, (_, i) => ({ position: i + 1, marks: 1 }));
    return {
      ...template,
      questionCount: slots.length,
      totalMarks: official.marks,
      slots,
      official: { ...official, rescaled: true },
      // Always credible: every slot is one mark by construction.
      shapeCredible: true,
    };
  }

  // The question count stays measured. It is the one thing the corpus reports
  // reliably -- a paper's questions are all present even when their marks are
  // not -- and the board states a total without saying how many questions
  // carry it.
  const already = template.totalMarks === official.marks;
  const slots = already ? template.slots : rescale(template.slots, official.marks);
  return {
    ...template,
    totalMarks: official.marks,
    slots,
    official: { ...official, rescaled: !already },
    shapeCredible: credible({ ...template, slots }),
  };
}
