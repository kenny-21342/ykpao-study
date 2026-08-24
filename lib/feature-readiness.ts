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
      'Only a small share of the past-paper archive has been turned into individual questions so far, and some questions refer to diagrams that have not been extracted yet. What is here is usable, but it is not the finished bank — use Past Papers for complete papers in the meantime.',
  },
  'mock-exams': {
    state: 'preview',
    badge: 'Preview',
    title: 'Mock exams are still in preview',
    body:
      'Papers are assembled from the question bank, which is still incomplete, so generation can time out or produce a paper that is thinner than a real one. Treat anything generated here as practice material, not as a realistic sitting.',
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
