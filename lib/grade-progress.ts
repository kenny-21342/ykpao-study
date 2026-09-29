/**
 * Whether a student is on track for the grade they are aiming at.
 *
 * Deliberately narrow about what counts as evidence. The only samples used are
 * *submitted, marked mock exams*, because a grade boundary is defined against a
 * whole paper and that is the one thing on the platform measured the same way.
 * Bank practice is per-question, often self-marked, and biased by construction
 * -- students practise the topics they are worst at -- so averaging it into a
 * predicted grade would read as a prediction while behaving like a complaint.
 *
 * The other rule is that too little evidence produces no prediction at all.
 * One paper is a mood, not a trend, and "at risk" off a single bad afternoon is
 * how a student learns to ignore the indicator.
 */

import { thresholdForGrade, type BoundaryRow, type GradeTarget } from './grade-boundaries.ts';

/** How many recent papers are averaged, at most. */
export const SAMPLE_WINDOW = 5;
/** Below this many marked papers there is no prediction. */
export const MIN_SAMPLES = 2;
/** Percentage points below the target that still counts as "close". */
export const CLOSE_MARGIN = 5;

export type PaperSample = {
  /** Marks awarded. */
  score: number;
  totalMarks: number;
  /** Used only to order the window; newest first. */
  submittedAt: Date | string;
};

export type TargetStatus = 'on-track' | 'close' | 'at-risk' | 'insufficient-data';

export type GradeProgress = {
  status: TargetStatus;
  target: GradeTarget;
  /** Mean percentage across the window, or null when there is no basis. */
  averagePercent: number | null;
  /** How many papers the figure is based on. */
  sampleCount: number;
  /** Percentage points from the target; negative means short. */
  gap: number | null;
};

/**
 * Average the most recent papers and compare to the target threshold.
 *
 * Returns null when there is no usable target, so a caller can distinguish
 * "no target set" (render nothing) from "target set but not enough work yet"
 * (render the invitation to sit a paper), which are different messages.
 */
export function progressTowardTarget(input: {
  samples: PaperSample[];
  target: GradeTarget | null;
}): GradeProgress | null {
  if (!input.target) return null;

  const usable = input.samples
    .filter((sample) => sample.totalMarks > 0 && Number.isFinite(sample.score))
    .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime())
    .slice(0, SAMPLE_WINDOW);

  if (usable.length < MIN_SAMPLES) {
    return {
      status: 'insufficient-data',
      target: input.target,
      averagePercent: null,
      sampleCount: usable.length,
      gap: null,
    };
  }

  const mean = usable.reduce((sum, s) => sum + (s.score / s.totalMarks) * 100, 0) / usable.length;
  const averagePercent = Math.round(mean);
  const gap = averagePercent - input.target.requiredPercent;

  return {
    status: gap >= 0 ? 'on-track' : gap >= -CLOSE_MARGIN ? 'close' : 'at-risk',
    target: input.target,
    averagePercent,
    sampleCount: usable.length,
    gap,
  };
}

/** One short line for the card, in the student's own terms. */
export function progressLabel(progress: GradeProgress): string {
  const { target, status, averagePercent, gap, sampleCount } = progress;
  if (status === 'insufficient-data') {
    return sampleCount === 0
      ? `Target ${target.grade} — sit a mock exam to see if you are on track`
      : `Target ${target.grade} — one more mock exam and we can tell you if you are on track`;
  }
  if (status === 'on-track') return `On track for ${target.grade} — averaging ${averagePercent}%`;
  const short = Math.abs(gap ?? 0);
  if (status === 'close') return `${short} point${short === 1 ? '' : 's'} off ${target.grade} — averaging ${averagePercent}%`;
  return `Below target ${target.grade} — averaging ${averagePercent}%, need ${target.requiredPercent}%`;
}

/**
 * Convenience for a caller that has rows rather than a resolved target.
 * Keeps the boundary resolution in one place.
 */
export function progressFromRows(input: {
  samples: PaperSample[];
  targetGrade: string | null;
  board: string;
  rows: BoundaryRow[];
}): GradeProgress | null {
  if (!input.targetGrade) return null;
  const target = thresholdForGrade({ grade: input.targetGrade, board: input.board, rows: input.rows });
  return progressTowardTarget({ samples: input.samples, target });
}
