/**
 * How large a mock exam is allowed to be.
 *
 * This is a *deployment* limit, not a pedagogical one. Grading makes one LLM
 * call per item (plus an OCR call for any photographed working) at
 * `GRADING_CONCURRENCY` in flight, so the whole submission has to finish inside
 * one serverless invocation:
 *
 *   items / concurrency × ~5-8s per item  <  the platform's function timeout
 *
 * On Vercel Hobby that timeout is 60s, which allows roughly 12 items at a
 * concurrency of 4. On Pro (300s) the same arithmetic supports the full 60.
 *
 * Generation and grading share this constant deliberately. When they differed,
 * `submit` truncated with `take:` — a student answered twenty questions, twelve
 * came back graded, and the other eight silently vanished with nothing in the
 * UI to explain it.
 *
 * **Raising this requires raising `maxDuration` in
 * `app/api/mock-exams/[id]/submit/route.ts` to match**, which in turn requires
 * a plan that permits it. Changing this number alone will produce timeouts
 * instead of larger exams.
 */
export const MAX_EXAM_ITEMS = 12;

/**
 * Concurrent grading calls per submission.
 *
 * Grading was originally strictly sequential to stay clear of DeepSeek's rate
 * limits. Four keeps that concern satisfied while cutting wall-clock time by
 * about four times, which is what brings a full paper inside the timeout.
 */
export const GRADING_CONCURRENCY = 4;
