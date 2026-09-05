/**
 * Planning backwards from an exam date instead of forwards from today.
 *
 * `generatePlan` builds a week from availability, weekly minutes and topic
 * mastery, and never reads `profile.examDate` -- so it produces the same flat
 * rolling seven days whether the exam is in three weeks or ten months. The
 * date is collected in onboarding and drives nothing.
 *
 * Pure: dates in, shape out, no database. The scheduling rules are the part
 * worth testing, and they are testable here without a plan being written.
 */

/** Beyond this the plan is guesswork, and a student will not follow it. */
export const MAX_PLAN_DAYS = 28;

/** Below this a "week" is whatever is left before the exam. */
export const FINAL_STRETCH_DAYS = 7;

export type PlanWindow = {
  /** How many days the plan spans, always at least 1. */
  days: number;
  /** Null when there is no future exam date to plan against. */
  daysUntilExam: number | null;
  phase: 'no-exam' | 'far' | 'approaching' | 'final-week';
  /**
   * Multiplier on the last day's capacity. 1 means flat -- the behaviour when
   * there is no exam to ramp towards, which must not change.
   */
  peakIntensity: number;
};

function daysBetween(from: Date, to: Date): number {
  const start = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const end = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((end - start) / 86_400_000);
}

/**
 * How long the plan should run, and how hard it should ramp.
 *
 * An exam in the past is treated as no exam at all rather than as an emergency:
 * a stale date on a profile is far more likely than a student revising for a
 * paper they have already sat.
 */
export function planWindow({ examDate, now = new Date() }: { examDate: Date | null; now?: Date }): PlanWindow {
  if (!examDate) {
    return { days: 7, daysUntilExam: null, phase: 'no-exam', peakIntensity: 1 };
  }

  const remaining = daysBetween(now, examDate);
  if (remaining <= 0) {
    return { days: 7, daysUntilExam: null, phase: 'no-exam', peakIntensity: 1 };
  }

  if (remaining <= FINAL_STRETCH_DAYS) {
    // Never schedule past the exam: a task due the day after it is noise.
    return {
      days: remaining,
      daysUntilExam: remaining,
      phase: 'final-week',
      peakIntensity: 1.5,
    };
  }

  if (remaining <= MAX_PLAN_DAYS) {
    return {
      days: remaining,
      daysUntilExam: remaining,
      phase: 'approaching',
      peakIntensity: 1.4,
    };
  }

  // Months out. Plan a normal fortnight and stay honest that the intensity
  // does not need to rise yet -- ramping ten months early just burns a student
  // out before it matters.
  return { days: 14, daysUntilExam: remaining, phase: 'far', peakIntensity: 1 };
}

/**
 * The capacity multiplier for one day of the window.
 *
 * Linear from 1 on the first day to `peakIntensity` on the last, so the work
 * builds towards the exam rather than sitting flat and then stopping.
 */
export function intensityAt(window: PlanWindow, offset: number): number {
  if (window.peakIntensity <= 1 || window.days <= 1) return 1;
  const progress = Math.min(1, Math.max(0, offset / (window.days - 1)));
  return 1 + (window.peakIntensity - 1) * progress;
}

/**
 * The mean of `intensityAt` across the whole window.
 *
 * The minute budget and the daily capacity have to be derived from the same
 * curve, or the plan runs out of one before the other. `generatePlan` scales a
 * weekly target by `days / 7` to get its budget, but then spends each day at
 * `base * intensityAt(...)`, which is above 1 for every day but the first once
 * an exam date is set. The budget is therefore exhausted after roughly
 * `1 / meanIntensity` of the window, and no task is scheduled in the days that
 * remain -- the final week before the exam, which is the week that matters
 * most.
 *
 * Multiplying the budget by this restores the invariant. The ramp is linear,
 * so the mean is just the midpoint of its endpoints, but it is computed here
 * rather than assumed so that changing the curve cannot silently reintroduce
 * the gap.
 *
 * Returns exactly 1 when there is no ramp, so a student with no exam date gets
 * precisely the budget they got before.
 */
export function averageIntensity(window: PlanWindow): number {
  if (window.peakIntensity <= 1 || window.days <= 1) return 1;
  let total = 0;
  for (let offset = 0; offset < window.days; offset += 1) {
    total += intensityAt(window, offset);
  }
  return total / window.days;
}

/**
 * Minutes to hold back for spaced review before scheduling any practice.
 *
 * SM-2 cards are already due; scheduling practice on top of them means either
 * the cards are skipped or the day overruns. Two minutes a card is what a
 * review actually takes, and the reservation is capped so a 200-card backlog
 * does not consume a day whole.
 */
export function reviewReservation(dueCards: number, capacity: number): number {
  if (dueCards <= 0 || capacity <= 0) return 0;
  return Math.min(dueCards * 2, 30, Math.floor(capacity / 2));
}

/**
 * How many distinct topics the plan can cover, given how many slots it has.
 *
 * Every weak topic should be seen at least once before the exam. Where there
 * are more topics than slots the weakest come first -- priorities arrive
 * sorted -- rather than cycling through all of them and covering none twice.
 */
export function topicsToCover<T>(priorities: T[], slots: number): T[] {
  if (priorities.length === 0 || slots <= 0) return [];
  return priorities.slice(0, Math.max(1, Math.min(priorities.length, slots)));
}

/** The countdown line for the Today view, or null when there is no exam. */
export function describeCountdown(window: PlanWindow): string | null {
  if (window.daysUntilExam === null) return null;
  const days = window.daysUntilExam;
  if (days === 1) return 'Your exam is tomorrow.';
  if (days <= FINAL_STRETCH_DAYS) return `${days} days until your exam.`;
  const weeks = Math.floor(days / 7);
  return `${days} days until your exam — about ${weeks} week${weeks === 1 ? '' : 's'}.`;
}
