import { z } from 'zod';

/**
 * The per-course goal fields, shared by `/api/me/courses` and
 * `/api/onboarding` so the two cannot drift apart.
 *
 * Every field here is backed by an HTML input, and an untouched input submits
 * `''`, not `null`. `z.string().date()` rejects `''`, so a student who saved
 * their course list without filling in an exam date got a validation failure
 * for every course at once -- which is exactly what happened in production.
 * Empty is normalised to null before validation rather than being rejected.
 */
const emptyToNull = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

const optionalText = (max: number) =>
  z.preprocess(emptyToNull, z.string().trim().max(max).nullable().optional());

/** ISO `YYYY-MM-DD`, or nothing. */
export const optionalIsoDate = z.preprocess(
  emptyToNull,
  z.string().date().nullable().optional(),
);

export const CoursePreferenceFields = {
  targetGrade: optionalText(20),
  examDate: optionalIsoDate,
  currentLevel: optionalText(80),
  recentResult: optionalText(120),
};

/**
 * A human-readable reason a payload was rejected.
 *
 * `ZodError.message` is the JSON-serialised issue array -- returning it puts a
 * wall of regex in front of a student who simply left a date blank. That is
 * what this exists to prevent.
 */
export function describeValidationError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    if (!issue) return 'Some of those details could not be saved.';
    const field = issue.path.filter((part) => typeof part === 'string').pop();
    const label = typeof field === 'string' ? field : 'One of the fields';
    if (issue.code === 'invalid_format' || issue.code === 'invalid_type') {
      return `${label} is not in a format we can save. Check it and try again.`;
    }
    return issue.message;
  }
  return error instanceof Error ? error.message : 'Invalid request.';
}
