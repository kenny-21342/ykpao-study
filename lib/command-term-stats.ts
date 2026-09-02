/**
 * How a student scores per command term.
 *
 * Topic-level weakness answers "what don't I know"; this answers the other
 * question a mark scheme actually punishes -- "what am I not doing when the
 * paper asks me to do it". A student can be strong on every topic in a subject
 * and still lose a quarter of the paper by answering "evaluate" with a
 * description.
 *
 * Pure, so it can be unit-tested without a database and reused wherever the
 * attempts come from.
 */
import { commandTerm, commandTermLabel } from './command-terms.ts';

export type CommandTermAttempt = {
  /** null where the attempt was never marked. */
  isCorrect: boolean | null;
  score: number | null;
  totalMarks: number | null;
  /** Command-term slugs on the question that was attempted. */
  terms: string[];
};

export type CommandTermStat = {
  slug: string;
  label: string;
  band: 'recall' | 'procedure' | 'higher';
  attempts: number;
  correct: number;
  /** Percentage 0-100. Marks where the question is marked out of marks. */
  accuracy: number;
  /** True where the accuracy came from awarded marks, not right/wrong. */
  markBased: boolean;
  guidance: string;
};

/**
 * The minimum attempts before a term's accuracy is reported at all.
 *
 * Three attempts is not evidence of anything, and telling a student they are
 * "weak at evaluate" on the strength of one wrong answer is worse than telling
 * them nothing: they will spend revision time on it.
 */
export const MIN_ATTEMPTS_FOR_SIGNAL = 4;

export function summariseCommandTerms(attempts: CommandTermAttempt[]): CommandTermStat[] {
  const totals = new Map<
    string,
    { attempts: number; correct: number; scored: number; possible: number; marked: number }
  >();

  for (const attempt of attempts) {
    // An unmarked attempt is not a wrong one. Counting it either way would
    // report a term as weak because the student saved an answer and never
    // marked it, which is the opposite of the signal wanted here.
    const scored = attempt.score !== null && !!attempt.totalMarks;
    if (attempt.isCorrect === null && !scored) continue;

    for (const slug of new Set(attempt.terms)) {
      const term = commandTerm(slug);
      if (!term) continue; // A slug the vocabulary no longer carries.

      let row = totals.get(term.slug);
      if (!row) {
        row = { attempts: 0, correct: 0, scored: 0, possible: 0, marked: 0 };
        totals.set(term.slug, row);
      }
      row.attempts += 1;
      if (attempt.isCorrect === true) row.correct += 1;
      // Marks are the better signal on an extended-response question, where
      // "correct" is a boolean over something worth 12. Only counted when the
      // question actually carries a total, so a 0/null does not read as 0%.
      if (attempt.score !== null && attempt.totalMarks) {
        row.scored += attempt.score;
        row.possible += attempt.totalMarks;
        row.marked += 1;
      }
    }
  }

  const stats: CommandTermStat[] = [];
  for (const [slug, row] of totals) {
    const term = commandTerm(slug)!;
    // Mark-based only when most of the attempts carry marks; a mix of the two
    // would otherwise report a figure that is neither.
    const markBased = row.possible > 0 && row.marked >= row.attempts / 2;
    const accuracy = markBased
      ? (row.scored / row.possible) * 100
      : (row.correct / row.attempts) * 100;

    stats.push({
      slug,
      label: commandTermLabel(slug),
      band: term.band,
      attempts: row.attempts,
      correct: row.correct,
      accuracy: Math.round(accuracy),
      markBased,
      guidance: term.guidance,
    });
  }

  // Weakest first, and among equals the one with more evidence behind it.
  return stats.sort((a, b) => a.accuracy - b.accuracy || b.attempts - a.attempts);
}

/**
 * The term worth telling the student about, or null when nothing qualifies.
 *
 * Requires enough attempts to mean something and a gap worth acting on: a term
 * you score 78% on is not the reason you are losing marks.
 */
export function weakestCommandTerm(
  stats: CommandTermStat[],
  { minAttempts = MIN_ATTEMPTS_FOR_SIGNAL, ceiling = 70 } = {},
): CommandTermStat | null {
  const eligible = stats.filter(
    (stat) => stat.attempts >= minAttempts && stat.accuracy < ceiling,
  );
  return eligible[0] ?? null;
}
