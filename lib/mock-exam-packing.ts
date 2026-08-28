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
): SelectedQuestion[] {
  const chosen: SelectedQuestion[] = [];
  const usedPapers = new Set<number>();
  let marks = 0;

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

      chosen.push(candidate);
      usedPapers.add(candidate.paperId);
      marks += candidate.marks;
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
