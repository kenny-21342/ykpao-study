/**
 * The models a student may choose for the shared AI key.
 *
 * Client-safe on purpose: this module imports nothing, so the tutor's picker
 * and the server-side validation read the same list rather than drifting into
 * two copies that disagree about what is allowed.
 *
 * Only models on OpenCode Zen's free tier appear here, and only those that
 * speak OpenAI-compatible `/chat/completions` — `muse-spark-1.3-contributor-free`
 * (`/responses`) and `jev-1.13-free` (`/systemone`) cannot be called by this
 * codebase at all.
 *
 * The two NVIDIA Nemotron models are free and compatible and are still absent.
 * Their trial terms say "do not submit personal or confidential data", and
 * every tutor message carries a named student's own question, answer or notes.
 * That is a term of use rather than a preference, so it is not offered as a
 * choice. `tests/ai-credentials.test.ts` pins the exclusion.
 *
 * `retention` is shown to the student, which is the point of the picker beyond
 * mere fallback: /privacy has to tell them their work may become training
 * data, and this is what lets them do something about it without owning an API
 * key. Keep the wording honest — it is the only place most students will meet
 * the distinction.
 */

export type SharedModelChoice = {
  id: string;
  /** Short name for the picker. */
  label: string;
  /**
   * `zero`  — the provider keeps nothing and trains on nothing.
   * `trains` — during the free period, submissions may be used to improve the model.
   */
  retention: 'zero' | 'trains';
  /** One line under the label, in the student's terms rather than the vendor's. */
  note: string;
};

export const SHARED_MODEL_CHOICES: readonly SharedModelChoice[] = [
  {
    id: 'mimo-v2.6-flash-free',
    label: 'MiMo 2.6 Flash',
    retention: 'trains',
    note: 'Fastest to answer. The default.',
  },
  {
    id: 'space-bunny-free',
    label: 'Space Bunny',
    retention: 'zero',
    note: 'Your messages are not kept or used for training.',
  },
  {
    id: 'longcat-2.5-preview-free',
    label: 'LongCat 2.5',
    retention: 'zero',
    note: 'Your messages are not kept or used for training.',
  },
  {
    id: 'big-pickle',
    label: 'Big Pickle',
    retention: 'trains',
    note: 'Often the strongest on longer reasoning.',
  },
  {
    id: 'mimo-v2.5-free',
    label: 'MiMo 2.5',
    retention: 'trains',
    note: 'The older MiMo. Slower, sometimes more thorough.',
  },
  {
    id: 'ling-3.0-flash-fin-free',
    label: 'Ling 3.0 Flash',
    retention: 'trains',
    note: 'Another fast option.',
  },
] as const;

/**
 * What the shared key uses when the student has expressed no preference.
 *
 * Must be an id in the list above; `tests/ai-credentials.test.ts` checks it.
 */
export const DEFAULT_SHARED_MODEL = 'mimo-v2.6-flash-free';

/**
 * Whether an id is one a student is allowed to select.
 *
 * The server calls this on every request carrying a model. A client that asks
 * for anything else — a paid model, another provider's, a typo — is answered
 * with the configured model instead of an error, because the student did not
 * choose the bad value: a model they picked last term and that has since been
 * withdrawn arrives here exactly the same way.
 */
export function isSharedModelChoice(id: string | null | undefined): boolean {
  return SHARED_MODEL_CHOICES.some((choice) => choice.id === id);
}
