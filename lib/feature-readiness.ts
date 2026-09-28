/**
 * Which shipped-but-unfinished features get a "not ready yet" treatment.
 *
 * Both entries are 'ready' as of 27 Sep 2026, so nothing carries a banner or
 * a badge today. The table is kept rather than deleted because it is how a
 * feature gets labelled honestly the next time one ships half-done, and every
 * entrance already reads it.
 *
 * The copy below is left in place as the record of what was true when the
 * treatment was removed, measured against production that day rather than
 * inherited:
 *
 *  - Question bank: 66,756 published questions over 49 syllabuses, 85.9% with
 *    a mark scheme, 98.2% carrying a transcript -- so written answers are
 *    marked for the student rather than by them, which was the headline
 *    limitation. Topic coverage was 39.2% when this was written; the tagging
 *    run finished 28 Sep 2026 and it is now **90.1%**, with 84.3% also
 *    carrying a difficulty. Still open: 4.7% held back for a bad crop, and the
 *    remaining ~10% with no topic, so a topic filter still misses some of the
 *    bank rather than most of it. Re-measure before editing these numbers --
 *    they are production counts, not estimates.
 *  - Mock exams: papers were packed at random from questions that have a mark
 *    scheme, to hit a mark total -- not modelled on a real paper's structure
 *    and not weighted across topics. **Both halves are now fixed**, after this
 *    was flipped rather than before. A paper named by number is built from a
 *    blueprint measured over the real sittings, with the exam board's own mark
 *    total and duration; 146 of 165 paper groups have a usable blueprint and
 *    the rest still pack to a mark total. And every paper is now weighted
 *    across topics, from the subject's own observed distribution of marks.
 *    What remains: a paper cannot be balanced on questions that carry no topic
 *    -- 0-7% on twenty-one of the twenty-four large subjects -- so those fill
 *    whatever the weighted passes leave, and the two History syllabuses, 0460
 *    and 0470, are only 36-39% tagged and so are still packed unweighted on
 *    purpose. See the note at the top of
 *    `lib/mock-exam-selection.ts`, which remains the authority.
 *
 * Removing the treatment was the owner's decision, taken with those numbers
 * in front of him. If either feature should say something about itself again,
 * change the state here and every entrance follows.
 *
 * 'ready'   -- no treatment at all; the feature stands on its own.
 * 'preview' -- reachable, but every entrance carries a banner and a badge.
 * 'hidden'  -- the sidebar entrance is not rendered. Direct links, deep links
 *              and the in-app shortcuts from the dashboard and study plan
 *              still resolve, so this hides the front door, not the room.
 */
export type ReadinessState = 'ready' | 'preview' | 'hidden';

export type PreviewFeature = 'question-bank' | 'mock-exams';

export type FeatureReadiness = {
  state: ReadinessState;
  /** Short badge text next to the nav entry. Kept to one word where possible. */
  badge: string;
  /** Banner headline. */
  title: string;
  /** Banner body: what is incomplete, stated plainly. */
  body: string;
};

export const FEATURE_READINESS: Record<PreviewFeature, FeatureReadiness> = {
  'question-bank': {
    state: 'ready',
    badge: 'Preview',
    title: 'The question bank is still being built',
    body:
      'Most of the archive is here — around 67,000 questions across 49 syllabuses, each with the original crop and, for most of them, its mark scheme. Almost every question now carries a transcript, so written answers are marked for you rather than left for you to mark yourself, and nine in ten now carry topic tags. Two gaps remain: about 5% of questions are held back because their crop was cut wrongly, and the last tenth has no topic yet, so filtering by topic still misses a little of the bank.',
  },
  'mock-exams': {
    state: 'ready',
    badge: 'Preview',
    title: 'Mock exams are still in preview',
    body:
      'A paper that names a paper number now follows the real one’s shape: a blueprint measured from that subject’s past papers, with the mark total and duration printed on the exam board’s own cover. Papers are also weighted across topics the way the subject’s own past papers are — in IGCSE Physics that means about a third of the marks on motion, forces and energy and roughly one in two hundred on space physics, because that is how the real papers fall. Three things are still short of that. A few subjects — mostly IB Mathematics, where our extraction merged a whole paper into one question — have no usable blueprint and pack to the mark total you ask for. A small number of questions carry no topic yet, so they fill whatever the weighting leaves over. And the two IGCSE History syllabuses are only a third tagged, too little to weight honestly, so their papers are still drawn unweighted. Treat one as strong practice rather than a faithful sitting.',
  },
};

export function featureReadiness(feature: PreviewFeature): FeatureReadiness {
  return FEATURE_READINESS[feature];
}

/** True when the entrance should still be rendered at all. */
export function isFeatureVisible(feature: PreviewFeature): boolean {
  return FEATURE_READINESS[feature].state !== 'hidden';
}

/** True when the entrance needs a badge and the view needs a banner. */
export function isFeaturePreview(feature: PreviewFeature): boolean {
  return FEATURE_READINESS[feature].state === 'preview';
}
