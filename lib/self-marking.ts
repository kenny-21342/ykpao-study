/**
 * Self-marking a free-response question, and measuring how honest it is.
 *
 * Self-marking existed but was binary: the route took `selfMarkedCorrect` and
 * stored 1 or 0. On a 12-mark extended response that throws away almost
 * everything the student learned by marking it -- 7/12 and 0/12 were the same
 * row.
 *
 * The plan called for a checklist built from `BankMarkScheme.markingPoints`.
 * That column is empty on all 52,925 mark schemes, and always has been: the
 * corpus is crop-first, so a mark scheme is a picture of the mark scheme. What
 * does exist is `BankQuestion.totalMarks` -- on 11,718 of the 25,614 questions
 * that are actually self-marked, 11,234 of them worth more than one mark -- so
 * the student awards themselves a mark out of the total with the scheme in
 * front of them, which is the same act without the checklist.
 *
 * Pure: no database, no Prisma types, so the rules below are testable on their
 * own and the route cannot quietly disagree with the UI.
 */

/** A question the student can mark themselves, as far as marking is concerned. */
export type MarkableQuestion = {
  /** Null where the corpus never captured it; then only a verdict is possible. */
  totalMarks: number | null;
  /** True when a published answer key exists, which outranks self-marking. */
  hasAnswerKey: boolean;
};

export type SelfMarkInput = {
  /** Marks the student awarded themselves. */
  awardedMarks?: number | null;
  /** The old binary verdict, still sent when the question has no mark total. */
  selfMarkedCorrect?: boolean | null;
};

export type SelfMarkResult = {
  /**
   * Fraction of the marks available, 0-1, so it is comparable across questions
   * of different sizes -- the same scale `gradeAgainstKey` writes.
   */
  score: number;
  /**
   * Full marks only. A 5/6 is not "correct", and recording it as such would put
   * the question beyond the reach of the review queue when a mark was lost.
   */
  isCorrect: boolean;
  /** The raw marks awarded, kept for calibration; null when none were given. */
  awardedMarks: number | null;
};

export class SelfMarkError extends Error {}

/**
 * Turn what the student claims into what is stored.
 *
 * Throws rather than clamping when the marks are out of range: a 9 awarded on a
 * 6-mark question is a bug in the client or a probe at the API, and silently
 * storing 6 would hide both.
 */
export function resolveSelfMark(
  question: MarkableQuestion,
  input: SelfMarkInput,
): SelfMarkResult | null {
  if (question.hasAnswerKey) {
    // Precedence, unchanged: a published key settles the question and a student
    // cannot self-mark their way to a correct multiple-choice answer.
    throw new SelfMarkError('This question is marked against an answer key.');
  }

  const total = question.totalMarks;

  if (input.awardedMarks !== undefined && input.awardedMarks !== null) {
    if (!total || total <= 0) {
      throw new SelfMarkError('This question has no mark total to award against.');
    }
    if (!Number.isInteger(input.awardedMarks) || input.awardedMarks < 0) {
      throw new SelfMarkError('Awarded marks must be a whole number of 0 or more.');
    }
    if (input.awardedMarks > total) {
      throw new SelfMarkError(`This question is out of ${total} marks.`);
    }
    return {
      score: input.awardedMarks / total,
      isCorrect: input.awardedMarks === total,
      awardedMarks: input.awardedMarks,
    };
  }

  if (input.selfMarkedCorrect !== undefined && input.selfMarkedCorrect !== null) {
    // The fallback wherever the corpus never captured a mark total. Kept rather
    // than removed: a verdict is worth more than no attempt record at all.
    return {
      score: input.selfMarkedCorrect ? 1 : 0,
      isCorrect: input.selfMarkedCorrect,
      awardedMarks: null,
    };
  }

  return null;
}

// ---------- Calibration ----------

export type CalibrationSample = {
  /** Marks the student gave themselves. */
  selfAwarded: number;
  /** Marks a key or the model gave for the same attempt. */
  authoritative: number;
  totalMarks: number;
};

export type Calibration = {
  samples: number;
  /**
   * Mean marks awarded above (positive) or below (negative) the authoritative
   * mark. In marks, not percent, because that is the unit a student thinks in.
   */
  bias: number;
  /** Mean absolute gap, so consistent-but-wrong is distinguishable from noisy. */
  spread: number;
  direction: 'generous' | 'harsh' | 'accurate';
};

/**
 * How far a student's self-marking sits from a real mark.
 *
 * Only computable where an attempt was marked both ways, which is rare by
 * design -- the whole point of self-marking is that nothing else could mark it.
 * So this stays null far more often than not, and the UI must say nothing
 * rather than guess.
 */
export const MIN_CALIBRATION_SAMPLES = 5;

/** Under a fifth of a mark either way is not a bias worth reporting. */
const ACCURATE_WITHIN = 0.2;

export function calibrate(
  samples: CalibrationSample[],
  { minSamples = MIN_CALIBRATION_SAMPLES } = {},
): Calibration | null {
  const usable = samples.filter(
    (sample) =>
      sample.totalMarks > 0 &&
      Number.isFinite(sample.selfAwarded) &&
      Number.isFinite(sample.authoritative),
  );
  if (usable.length < minSamples) return null;

  let total = 0;
  let absolute = 0;
  for (const sample of usable) {
    const gap = sample.selfAwarded - sample.authoritative;
    total += gap;
    absolute += Math.abs(gap);
  }

  const bias = total / usable.length;
  return {
    samples: usable.length,
    bias: Math.round(bias * 10) / 10,
    spread: Math.round((absolute / usable.length) * 10) / 10,
    direction: bias > ACCURATE_WITHIN ? 'generous' : bias < -ACCURATE_WITHIN ? 'harsh' : 'accurate',
  };
}

/** One sentence for the coach, or null when there is nothing honest to say. */
export function describeCalibration(calibration: Calibration | null): string | null {
  if (!calibration || calibration.direction === 'accurate') return null;
  const marks = Math.abs(calibration.bias).toFixed(1);
  const verb = calibration.direction === 'generous' ? 'more' : 'fewer';
  return `You award yourself about ${marks} ${verb} mark${marks === '1.0' ? '' : 's'} than the mark scheme does, across ${calibration.samples} marked questions.`;
}
