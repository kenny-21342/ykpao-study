/**
 * The guided walkthrough a student sees once, straight after onboarding.
 *
 * The step list and the logic that picks the next usable step live here rather
 * than in the component so they can be unit-tested: which steps are shown
 * depends on what is actually on the page, and getting that wrong strands the
 * tour on a highlight pointing at nothing.
 */

export type TourStep = {
  /** Matches a `data-tour="..."` attribute in the shell. */
  anchor: string;
  title: string;
  body: string;
  /**
   * Which side of the anchor the card prefers. The component flips this when
   * there is no room, so it is a preference rather than an instruction.
   */
  placement: 'right' | 'bottom' | 'left';
};

export const TOUR_STEPS: TourStep[] = [
  {
    anchor: 'nav-dashboard',
    title: 'Your dashboard',
    body: 'Where you land each visit: your subjects, what is due, and the topics costing you the most marks.',
    placement: 'right',
  },
  {
    anchor: 'nav-study',
    title: 'Study',
    body: 'Plan from your exam dates, work through mistakes, and review flashcards. The plan rebuilds itself as you practise.',
    placement: 'right',
  },
  {
    anchor: 'nav-practice',
    title: 'Practice',
    body: 'Past paper questions from the bank, filtered by subject and topic. Answer one and it is marked against the real mark scheme.',
    placement: 'right',
  },
  {
    anchor: 'nav-papers',
    title: 'Past papers',
    body: 'The original PDFs, browsable by subject, year and session, when you would rather sit a whole paper.',
    placement: 'right',
  },
  {
    anchor: 'nav-mock-exams',
    title: 'Mock exams',
    body: 'Build a timed paper from the bank, sit it, and get it marked question by question.',
    placement: 'right',
  },
  {
    anchor: 'search',
    title: 'Search everything',
    body: 'Questions, mark schemes, your notes and uploaded resources, all from one box. ⌘K opens it from anywhere.',
    placement: 'right',
  },
  {
    anchor: 'ai-tutor',
    title: 'Your AI tutor',
    body: 'Ask about anything on screen. It can explain a step, give a hint instead of the answer, or turn its advice into scheduled tasks.',
    placement: 'bottom',
  },
];

/**
 * The steps whose anchor is actually on the page right now.
 *
 * Several entries are conditional in the shell: Practice and Mock exams are
 * behind feature flags, and the sidebar is not rendered at all on a narrow
 * screen until it is opened. Filtering up front means the tour never advances
 * onto a step it cannot point at, and never shows "3 of 7" when only four of
 * them exist.
 */
export function visibleSteps(
  steps: TourStep[],
  isPresent: (anchor: string) => boolean,
): TourStep[] {
  return steps.filter((step) => isPresent(step.anchor));
}

/**
 * Where to put the card, given the anchor's rectangle and the viewport.
 *
 * Returns viewport coordinates for the card's top-left corner. `right` flips
 * to `bottom` when the card would overflow, which is what happens on a phone
 * where the sidebar occupies most of the width.
 */
export function cardPosition(
  rect: { top: number; left: number; width: number; height: number },
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  placement: TourStep['placement'],
  gap = 12,
): { top: number; left: number } {
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const fitsRight = rect.left + rect.width + gap + card.width <= viewport.width;
  const fitsLeft = rect.left - gap - card.width >= 0;

  let top: number;
  let left: number;
  if (placement === 'right' && fitsRight) {
    left = rect.left + rect.width + gap;
    top = rect.top;
  } else if (placement === 'left' && fitsLeft) {
    left = rect.left - gap - card.width;
    top = rect.top;
  } else {
    // Below the anchor, and above it instead when there is no room below.
    left = rect.left;
    top = rect.top + rect.height + gap + card.height <= viewport.height
      ? rect.top + rect.height + gap
      : rect.top - gap - card.height;
  }

  return {
    top: clamp(top, gap, Math.max(gap, viewport.height - card.height - gap)),
    left: clamp(left, gap, Math.max(gap, viewport.width - card.width - gap)),
  };
}
