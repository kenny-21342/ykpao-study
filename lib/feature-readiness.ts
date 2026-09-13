/**
 * Which shipped-but-unfinished features get a "not ready yet" treatment.
 *
 * The question bank is at ~5% extraction coverage and the mock-exam generator
 * still fails on some attempts, so both would read as broken rather than as
 * unfinished if we launched them silently on 14 Sep. Rather than scatter
 * conditionals through the UI, every entrance reads this one table.
 *
 * 'ready'   — no treatment at all; the feature stands on its own.
 * 'preview' — reachable, but every entrance carries a banner and a badge.
 * 'hidden'  — the sidebar entrance is not rendered. Direct links, deep links
 *             and the in-app shortcuts from the dashboard and study plan still
 *             resolve, so this hides the front door, not the room. Removing
 *             those too is a bigger change than the launch needs today.
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
    state: 'preview',
    badge: 'Preview',
    title: 'The question bank is still being built',
    body:
      'Most of the archive is here — around 67,000 questions across 49 syllabuses, each with the original crop and, for three quarters of them, its mark scheme. Two gaps remain: multiple-choice questions can be marked automatically but written answers are marked by you against the mark scheme, and about 5% of questions are held back because their crop was cut wrongly.',
  },
  'mock-exams': {
    state: 'preview',
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
