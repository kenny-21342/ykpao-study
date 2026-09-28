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
 *    and not weighted across topics. **The first half of that is now fixed**,
 *    after this was flipped rather than before: a paper named by number is
 *    built from a blueprint measured over the real sittings, and its mark
 *    total and duration are the exam board's own. 146 of 165 paper groups have
 *    a usable blueprint; the rest still pack to a mark total. Topic weighting
 *    is still not done. See the note at the top of
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
      'Papers are drawn at random from past questions that have a mark scheme, to hit the mark total you ask for. They are not modelled on the structure of a real paper, and they are not topic-matched yet, so treat one as practice material rather than a realistic sitting.',
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
