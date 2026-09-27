/**
 * Packing chosen questions into a paper that hits its mark target.
 *
 * Split from `mock-exam-selection.ts`, which owns the database query, so that
 * the arithmetic here can be tested without a Prisma client -- the same split
 * `mock-exam-prompt.ts` already uses.
 */

export type SelectedQuestion = {
  id: number;
  marks: number;
  paperId: number;
  year: number;
  /**
   * Whether the mark scheme carries an answer key. Keyed questions cost nothing
   * to grade, so they are capped separately -- see `maxUnkeyedItems`.
   */
  keyed: boolean;
};

/**
 * Greedily fill a paper to its mark target without overshooting.
 *
 * Exam papers are not a knapsack problem worth solving exactly -- a paper two
 * marks under target is a fine paper, and a student cannot tell. What they can
 * tell is a paper that repeats a question, or draws every question from one
 * 2019 paper, so the pass below spreads across source papers first and only
 * doubles up on a paper once it has run out of fresh ones.
 *
 * Exported for tests: this is the part with arithmetic in it.
 */
export function packToTarget(
  candidates: SelectedQuestion[],
  targetMarks: number,
  maxItems: number,
  /**
   * How many chosen questions may lack an answer key. Each of those costs one
   * LLM completion at submission, which is the only thing bounding paper size;
   * keyed questions are free to mark and bound only by `maxItems`.
   */
  maxUnkeyedItems: number = maxItems,
): SelectedQuestion[] {
  const chosen: SelectedQuestion[] = [];
  const usedPapers = new Set<number>();
  let marks = 0;
  let unkeyed = 0;

  // Two passes over the same shuffled list: the first takes at most one
  // question per paper, the second fills any remaining room from whatever is
  // left. Without the first pass a random draw clusters, because a paper with
  // forty short questions is forty chances to be picked.
  for (const pass of [0, 1]) {
    for (const candidate of candidates) {
      if (chosen.length >= maxItems || marks >= targetMarks) break;
      if (chosen.some((picked) => picked.id === candidate.id)) continue;
      if (pass === 0 && usedPapers.has(candidate.paperId)) continue;
      // Skip anything that would overshoot; a later, smaller candidate may fit.
      if (marks + candidate.marks > targetMarks) continue;
      // A paper may still take keyed questions after its grading budget is
      // spent, so this skips rather than breaks.
      if (!candidate.keyed && unkeyed >= maxUnkeyedItems) continue;

      chosen.push(candidate);
      usedPapers.add(candidate.paperId);
      marks += candidate.marks;
      if (!candidate.keyed) unkeyed += 1;
    }
  }

  // A target smaller than every available question would otherwise return an
  // empty paper, which reads as the old "no questions" failure. One question
  // over target beats nothing at all.
  if (chosen.length === 0 && candidates.length > 0) {
    const smallest = candidates.reduce((min, c) => (c.marks < min.marks ? c : min));
    chosen.push(smallest);
  }

  // Present in a stable reading order rather than the order they were drawn.
  return chosen.sort((a, b) => a.year - b.year || a.paperId - b.paperId || a.id - b.id);
}

/** The marks a selection actually adds up to. */
export function totalMarksOf(questions: SelectedQuestion[]): number {
  return questions.reduce((sum, question) => sum + question.marks, 0);
}

/**
 * Assign candidates to slots, pure so the widening rules can be tested.
 *
 * Exported for the test: the interesting behaviour is what happens when the
 * pool cannot satisfy a slot exactly, and that is hard to arrange against a
 * real corpus that always can.
 */
export function fillSlots(
  slots: readonly { position: number; marks: number }[],
  candidates: readonly SelectedQuestion[],
): SelectedQuestion[] {
  const used = new Set<number>();
  // Questions drawn from one source paper look like a reprint of that paper
  // rather than a new one, so a paper already drawn from is a last resort for
  // the next slot -- but never a reason to leave a slot empty.
  const papersDrawn = new Set<number>();
  const chosen: SelectedQuestion[] = [];

  const take = (predicate: (candidate: SelectedQuestion) => boolean): SelectedQuestion | null => {
    const fresh = candidates.find((c) => !used.has(c.id) && !papersDrawn.has(c.paperId) && predicate(c));
    const any = fresh ?? candidates.find((c) => !used.has(c.id) && predicate(c));
    if (!any) return null;
    used.add(any.id);
    papersDrawn.add(any.paperId);
    return any;
  };

  for (const slot of slots) {
    const pick =
      take((c) => c.marks === slot.marks)
      ?? take((c) => Math.abs(c.marks - slot.marks) <= 1)
      ?? take((c) => Math.abs(c.marks - slot.marks) <= 3)
      // A slot with nothing close left takes the nearest thing remaining
      // rather than being dropped: a paper one question short is more
      // obviously broken to a student than one question slightly mis-weighted.
      ?? take(() => true);
    if (pick) chosen.push(pick);
  }
  return chosen;
}
