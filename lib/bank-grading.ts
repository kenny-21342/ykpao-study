/**
 * Marking a bank question against its stored answer key.
 *
 * 24,356 of the 66,758 published questions carry a `BankMarkScheme.answerLetter`
 * -- the whole multiple-choice half of Physics, Biology, Chemistry and
 * Economics. Marking those is a character comparison, so it costs nothing, and
 * it runs in the request rather than behind a provider whose median call is
 * 7-27 seconds. Before this existed the only marking path in the app went to
 * the model, which is why a one-letter answer to the daily challenge took
 * twenty seconds to come back and then said nothing.
 *
 * Everything else -- free response, and the subjects whose mark schemes are
 * prose rather than an answer key -- has no key to compare against and is left
 * to the student to mark against the mark scheme.
 */

/** How an attempt was marked. Mirrors `BankQuestionAttempt.gradedBy`. */
export type GradedBy = 'key' | 'self' | 'ai';

export type KeyGrade = {
  isCorrect: boolean;
  score: number;
  gradedBy: 'key';
  /** The stored key, so the UI can show the right answer on a wrong attempt. */
  correctLetter: string;
};

/**
 * The option letter a student meant, or null if their answer is not one.
 *
 * Students type the letter a dozen ways -- "a", "A.", "(B)", "C)" -- and the
 * option row itself is sometimes pasted back in full ("A Open Closed Closed"),
 * which is why a leading letter followed by a separator counts. What does not
 * count is prose that merely starts with a letter word, so a bare token is
 * required rather than a prefix match on anything.
 */
export function normalizeOptionLetter(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // A leading option letter, optionally bracketed, optionally followed by a
  // separator and the rest of the option text.
  const match = /^\(?\s*([A-Za-z])\s*[).:,-]?(\s|$)/.exec(trimmed);
  if (!match) return null;

  const letter = match[1].toUpperCase();
  // Exam options never run past E; a longer alphabet would be a parsing
  // accident, not a real answer.
  return letter >= 'A' && letter <= 'E' ? letter : null;
}

/**
 * Mark an answer against a stored key.
 *
 * Returns null when there is no key, which is the caller's signal to record the
 * attempt unmarked and hand the student the mark scheme instead. An
 * unrecognisable answer to a keyed question is wrong, not unmarkable: the
 * student had four options and did not pick one of them.
 */
export function gradeAgainstKey(
  answer: string,
  answerLetter: string | null | undefined,
): KeyGrade | null {
  const key = answerLetter?.trim().toUpperCase();
  if (!key) return null;

  const picked = normalizeOptionLetter(answer);
  const isCorrect = picked !== null && picked === key;

  return { isCorrect, score: isCorrect ? 1 : 0, gradedBy: 'key', correctLetter: key };
}

/**
 * The options a keyed question offers.
 *
 * The bank stores the key but never the option list -- the options live in the
 * crop image, which is what the student reads. Four is the CAIE standard across
 * every subject with an answer key in this corpus, and the key itself widens it
 * if a paper ever uses five.
 */
export function optionLettersFor(answerLetter: string | null | undefined): string[] {
  const base = ['A', 'B', 'C', 'D'];
  const key = answerLetter?.trim().toUpperCase();
  if (key && key > 'D' && key <= 'E') return [...base, 'E'];
  return base;
}
