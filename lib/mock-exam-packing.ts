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
  /**
   * The question's primary syllabus topic, or null if it has none.
   *
   * Most questions carry exactly one (38,346 of the 52,743 eligible ones);
   * around a sixth carry two or more, and the draw takes the most confident.
   * 6.2% carry none at all, and those are still usable -- they simply cannot
   * be balanced, so they fill what the balanced passes leave over.
   */
  topicId: number | null;
};

/** A topic and the share of a subject's marks it accounts for, 0..1. */
export type TopicWeight = { topicId: number; share: number };

/** Topic shares keyed for lookup, as the packers want them. */
export function topicShares(weights: readonly TopicWeight[]): Map<number, number> {
  return new Map(weights.map((weight) => [weight.topicId, weight.share]));
}

/**
 * The most questions a topic may hold in a paper of `size` questions.
 *
 * A *running* limit, re-evaluated as the paper grows, rather than a quota
 * apportioned up front. Two earlier attempts failed for the same underlying
 * reason -- how many questions a paper ends up holding is not known when the
 * draw begins:
 *
 *  - Quotas in marks. The bank is 75% one-mark multiple choice, so a 50-mark
 *    paper is really a 12-question paper, and IGCSE Biology's 21 topics got
 *    about 3 marks each: less than one structured question, so nothing could
 *    satisfy its own topic. Papers fell from 31 marks to 14.
 *  - Quotas in questions, apportioned to the item cap. A draw that preferred
 *    large questions filled fifty marks with five of them rather than twelve,
 *    so a quota of "4 of 12" let one topic take four of five questions.
 *    Worst-topic share went from 26% to 55%.
 *
 * Scaling with the paper's current size fixes both. At five questions IGCSE
 * Physics allows its heaviest topic ceil(0.331 x 5) = 2, which is 40% of a
 * five-question paper against a 33.1% syllabus share; at twelve it allows 4.
 * The limit is never below 1, so any topic may open a paper, and rounding up
 * keeps it achievable rather than blocking a short paper entirely.
 */
export function topicAllowance(share: number, size: number): number {
  return Math.max(1, Math.ceil(share * size));
}

/**
 * Greedily fill a paper to its mark target without overshooting.
 *
 * Exam papers are not a knapsack problem worth solving exactly -- a paper two
 * marks under target is a fine paper, and a student cannot tell. What they can
 * tell is a paper that repeats a question, or draws every question from one
 * 2019 paper, or claims fifty marks and holds twenty-six.
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
  /**
   * Topic shares, from `topicShares`. Omitted, the draw ignores topics
   * entirely -- which is what a subject with no usable topic data gets.
   */
  shares?: ReadonlyMap<number, number>,
): SelectedQuestion[] {
  /**
   * Build a paper of at most `intendedItems` questions.
   *
   * Called repeatedly by the search below, so every piece of state it keeps is
   * local to one attempt.
   */
  const attempt = (intendedItems: number): SelectedQuestion[] => {
    const chosen: SelectedQuestion[] = [];
    const picked = new Set<number>();
    const usedPapers = new Set<number>();
    /** Questions already taken from each topic, against its running allowance. */
    const takenByTopic = new Map<number, number>();
    let marks = 0;
    let unkeyed = 0;

    const withinAllowance = (candidate: SelectedQuestion): boolean => {
      if (!shares || candidate.topicId === null) return false;
      const share = shares.get(candidate.topicId);
      if (share === undefined) return false;
      // Measured against the paper this question would produce, not the one it
      // is joining, so the very first pick is never blocked by a limit computed
      // for an empty paper.
      return (takenByTopic.get(candidate.topicId) ?? 0) < topicAllowance(share, chosen.length + 1);
    };

    /*
     * One pick at a time, each one choosing the question that best fits what the
     * paper still needs.
     *
     * The thing that has to be right is *question size*, and neither obvious
     * rule gets it right. Taking candidates in the order they were drawn spends
     * every item slot on one-mark multiple choice -- 75% of eligible IGCSE
     * Physics questions are exactly that -- so a "50-mark paper" came back
     * holding 26 to 42 marks depending on the subject. That was a real,
     * pre-existing defect, not a rounding error. Sorting largest-first fixes the
     * total and breaks the paper a different way: fifty marks of the biggest
     * available questions is two to five of them, and a two-question mock exam
     * covers two topics however well it is balanced.
     *
     * So the target size is derived, not fixed: the marks still missing spread
     * over the slots still free. A fresh 50-mark, 12-item paper wants about 4.2
     * marks; take a one-mark question and the next wants 4.5; take an eleven
     * and the next wants 3.5. It self-corrects, it needs no knowledge of how the
     * bank is shaped, and it lands a full twelve questions on every subject
     * measured -- including the two whose banks hold nothing between 1 mark and
     * 6, where it simply mixes the two sizes instead of committing to either.
     *
     * Within that, four preference tiers, most wanted first:
     *
     *  0. a fresh source paper AND the question's topic still under allowance
     *  1. topic under allowance, source paper may repeat
     *  2. a fresh source paper
     *  3. anything that fits
     *
     * Tiers 0 and 1 are what balances the paper: a subject whose bank leans on
     * one topic -- and they all do, because a topic holding 33% of the marks is
     * 33% of the draw -- would otherwise produce a paper that leans the same
     * way, only harder, since twelve questions is a small sample. Tier 3 is why
     * this can never make a paper worse: the allowance decides which question is
     * *preferred*, never whether the paper reaches its target, and untagged
     * questions carry no topic so they can only be taken there.
     *
     * Tier 2 predates topic balance and survives it. Without it a draw clusters
     * on one source paper, because a paper contributing forty short questions is
     * forty chances to be picked.
     *
     * Sorting does not make papers predictable: which questions are in the pool
     * is still `ORDER BY random()` in SQL, and there are far more ways to reach
     * fifty marks than a student will ever sit.
     */
    while (chosen.length < intendedItems && marks < targetMarks) {
      const wanted = (targetMarks - marks) / Math.max(1, intendedItems - chosen.length);
      let best: SelectedQuestion | null = null;
      let bestRank = Infinity;

      for (const candidate of candidates) {
        if (picked.has(candidate.id)) continue;
        // Skip anything that would overshoot; a smaller candidate may still fit.
        if (marks + candidate.marks > targetMarks) continue;
        // A paper may still take keyed questions after its grading budget is
        // spent, so this skips rather than stops.
        if (!candidate.keyed && unkeyed >= maxUnkeyedItems) continue;

        const fresh = !usedPapers.has(candidate.paperId);
        const roomy = !shares || withinAllowance(candidate);
        const tier = roomy && fresh ? 0 : roomy ? 1 : fresh ? 2 : 3;
        // The tier dominates; distance from the wanted size only orders within
        // it. `targetMarks` bounds the distance, so the multiplier separates the
        // tiers for any paper a student could sit.
        const rank = tier * (targetMarks + 1) + Math.abs(candidate.marks - wanted);
        if (rank < bestRank) {
          bestRank = rank;
          best = candidate;
        }
      }

      if (!best) break;

      chosen.push(best);
      picked.add(best.id);
      usedPapers.add(best.paperId);
      marks += best.marks;
      if (!best.keyed) unkeyed += 1;
      if (best.topicId !== null) {
        takenByTopic.set(best.topicId, (takenByTopic.get(best.topicId) ?? 0) + 1);
      }
    }

      return chosen;
  };

  /*
   * `maxItems` is a ceiling on grading cost, not the length the paper wants to
   * be -- so the longest paper is tried first and shorter ones only if it
   * cannot reach the target.
   *
   * It has to work this way because the wanted size above is the deficit over
   * the slots still free, and that arithmetic can be unsatisfiable at one
   * length while being exact at another. A bank holding only 1-mark and
   * 11-mark questions -- which two subjects here genuinely are -- cannot make
   * fifty marks out of twelve questions at all: 11a + b = 50 with a + b = 12
   * has no whole-number answer, and the closest a twelve-question paper gets is
   * 42. Ten questions make exactly 50. Aiming at twelve and settling for 42
   * would have reintroduced the short-paper bug this whole function exists to
   * fix, in the one place it is least visible.
   *
   * So: the first length that reaches the target wins, and the longest paper is
   * tried first, which keeps topic coverage as high as the target allows. If no
   * length reaches it -- a thin pool, or a target the bank cannot express --
   * the best total found is returned rather than nothing.
   */
  let best: SelectedQuestion[] = [];
  for (let intended = maxItems; intended >= 1; intended -= 1) {
    const paper = attempt(intended);
    if (totalMarksOf(paper) >= targetMarks) {
      best = paper;
      break;
    }
    if (totalMarksOf(paper) > totalMarksOf(best)) best = paper;
  }

  // A target smaller than every available question would otherwise return an
  // empty paper, which reads as the old "no questions" failure. One question
  // over target beats nothing at all.
  if (best.length === 0 && candidates.length > 0) {
    best = [candidates.reduce((min, c) => (c.marks < min.marks ? c : min))];
  }

  // Present in a stable reading order rather than the order they were drawn.
  return [...best].sort((a, b) => a.year - b.year || a.paperId - b.paperId || a.id - b.id);
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
  /**
   * Topic shares, from `topicShares`. A slot prefers a question whose topic is
   * still under its running allowance, but a slot is never left empty over it
   * -- the blueprint's shape outranks its topic spread, because a missing
   * question is visible to a student and a slightly over-represented topic is
   * not.
   */
  shares?: ReadonlyMap<number, number>,
): SelectedQuestion[] {
  const used = new Set<number>();
  // Questions drawn from one source paper look like a reprint of that paper
  // rather than a new one, so a paper already drawn from is a last resort for
  // the next slot -- but never a reason to leave a slot empty.
  const papersDrawn = new Set<number>();
  const takenByTopic = new Map<number, number>();
  const chosen: SelectedQuestion[] = [];

  const withinQuota = (candidate: SelectedQuestion): boolean => {
    if (!shares || candidate.topicId === null) return false;
    const share = shares.get(candidate.topicId);
    if (share === undefined) return false;
    // Measured against the paper this question would produce, not the one it
    // is joining, so the very first pick is never blocked by a limit computed
    // for an empty paper.
    return (takenByTopic.get(candidate.topicId) ?? 0) < topicAllowance(share, chosen.length + 1);
  };

  const take = (predicate: (candidate: SelectedQuestion) => boolean): SelectedQuestion | null => {
    const free = (c: SelectedQuestion) => !used.has(c.id) && predicate(c);
    // Preference order, most wanted first: a fresh paper and a topic with room,
    // then either one on its own, then anything that matches the slot at all.
    const pick =
      (shares && candidates.find((c) => free(c) && !papersDrawn.has(c.paperId) && withinQuota(c)))
      ?? (shares && candidates.find((c) => free(c) && withinQuota(c)))
      ?? candidates.find((c) => free(c) && !papersDrawn.has(c.paperId))
      ?? candidates.find(free);
    if (!pick) return null;
    used.add(pick.id);
    papersDrawn.add(pick.paperId);
    if (pick.topicId !== null) {
      takenByTopic.set(pick.topicId, (takenByTopic.get(pick.topicId) ?? 0) + 1);
    }
    return pick;
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
