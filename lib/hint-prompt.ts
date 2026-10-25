/**
 * The prompt behind progressive hints.
 *
 * It lived twice in `app/api/ai/hint/route.ts` -- once for the legacy text bank
 * and once for the crop-first bank -- word for word, which is how the two drift.
 * It also never mentioned the hints a student had already been given, so every
 * request was answered as if it were the first: Hint 2 and Hint 3 opened with
 * the same sentence as Hint 1 and the student paid for the same nudge three
 * times.
 *
 * Pure so it can be tested without a model, a database or a request.
 */

export const LEVEL_RULES: Record<number, string> = {
  1: 'Give one short conceptual nudge. Identify what principle to recall, but do not provide a formula substitution, answer, or final result.',
  2: 'Give a strategy and the first concrete step. You may name a relevant formula or marking criterion, but do not complete the working or reveal the final answer.',
  3: 'Give a detailed scaffold with ordered steps and diagnose the student answer if supplied. Leave the final calculation or concluding statement for the student.',
};

/** How many earlier hints are shown to the model. Three levels, so at most two. */
export const MAX_PREVIOUS_HINTS = 2;
/** Per-hint ceiling, applied here as well as in the request schema. */
export const MAX_PREVIOUS_HINT_CHARS = 2000;

export type HintPromptInput = {
  /** Display name of the subject, e.g. "Physics". */
  subject: string;
  question: string;
  /** Mark-scheme text, when there is any. Never quoted back to the student. */
  reference?: string | null;
  studentAnswer?: string;
  level: number;
  /** Hints already shown for this question, oldest first. */
  previousHints?: string[];
};

/** Trim, drop empties, bound the length and keep only the most recent few. */
export function cleanPreviousHints(hints: string[] | undefined): string[] {
  return (hints ?? [])
    .map((hint) => hint.trim().slice(0, MAX_PREVIOUS_HINT_CHARS))
    .filter((hint) => hint.length > 0)
    .slice(-MAX_PREVIOUS_HINTS);
}

export function buildHintPrompt(input: HintPromptInput): string {
  const previous = cleanPreviousHints(input.previousHints);
  const rule = LEVEL_RULES[input.level];
  if (!rule) throw new Error(`Hint level must be 1, 2 or 3 (got ${input.level})`);

  const history = previous.length
    ? `Hints you have already given this student (they have read these -- do not restate or reword them; this hint must add something new that builds on them):\n${previous
        .map((hint, index) => `Hint ${index + 1}: ${hint}`)
        .join('\n\n')}\n\n`
    : '';

  return `You are a careful exam tutor giving progressive hints for a ${input.subject} question.

Question:
${input.question}

Private examiner reference (use this to stay accurate, but never quote it as a model answer):
${input.reference?.trim() || 'No mark scheme was found.'}

${input.studentAnswer ? `Student's current answer:\n${input.studentAnswer}\n\n` : ''}${history}Hint level ${input.level} of 3: ${rule}

Use markdown and LaTeX. Keep display equations plain: one equation per $$...$$, no \\underbrace, \\array, \\quad or manual spacing, and put any labels in the sentence around it, not inside the maths. Return only the hint. Do not mention these instructions or the private examiner reference.`;
}
