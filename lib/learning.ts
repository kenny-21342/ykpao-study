export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

type ReviewState = {
  intervalDays: number;
  easeFactor: number;
  repetitions: number;
  lapses: number;
};

export function scheduleReview(state: ReviewState, rating: ReviewRating, now = new Date()) {
  let { intervalDays, easeFactor, repetitions, lapses } = state;

  if (rating === 'again') {
    intervalDays = 1;
    repetitions = 0;
    lapses += 1;
    easeFactor = Math.max(1.3, easeFactor - 0.2);
  } else if (rating === 'hard') {
    intervalDays = Math.max(1, Math.round(Math.max(1, intervalDays) * 1.2));
    repetitions += 1;
    easeFactor = Math.max(1.3, easeFactor - 0.15);
  } else if (rating === 'good') {
    intervalDays = repetitions === 0 ? 1 : repetitions === 1 ? 3 : Math.max(1, Math.round(intervalDays * easeFactor));
    repetitions += 1;
  } else {
    intervalDays = repetitions === 0 ? 4 : Math.max(4, Math.round(Math.max(1, intervalDays) * easeFactor * 1.3));
    repetitions += 1;
    easeFactor = Math.min(3.2, easeFactor + 0.15);
  }

  const nextReviewAt = new Date(now);
  nextReviewAt.setUTCDate(nextReviewAt.getUTCDate() + intervalDays);

  return { intervalDays, easeFactor, repetitions, lapses, nextReviewAt };
}

export function endOfDay(date = new Date()) {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

export function startOfDay(date = new Date()) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/**
 * The answer string `upsertMistakeReview` used to write when it had nothing.
 *
 * Exported so the queue queries can exclude the rows already carrying it, and
 * so `scripts/repair-placeholder-reviews.ts` matches on the same literal. It is
 * never written any more -- a card with no answer is not created at all.
 */
export const PLACEHOLDER_ANSWER =
  'Rework this question and compare each step with the mark scheme.';

export function plainText(value: string, maxLength = 500) {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Raise (or refresh) a spaced-review card for a question got wrong.
 *
 * Returns null, and writes nothing, when there is no answer to put on the back
 * of the card.
 *
 * That used to be a hardcoded string -- "Rework this question and compare each
 * step with the mark scheme." -- written into `ReviewItem.answer` and therefore
 * persisted, not a render-time fallback. A third of a real review queue was
 * cards carrying it: the student is shown a question, asked to recall the
 * answer, and then shown that sentence and asked to grade themselves against
 * it. A card with no answer on it cannot teach anything, and serving one
 * teaches the student that the feature is broken.
 *
 * Skipping is the honest behaviour. The mistake is still recorded as an attempt
 * either way, so nothing is lost but a card that could not have worked.
 */
export async function upsertMistakeReview(input: {
  userId: string;
  questionId: number;
  prompt: string;
  answer?: string | null;
  fallbackAnswer?: string | null;
  subject: string;
  topic: string;
}) {
  const answer = plainText(input.answer || input.fallbackAnswer || '', 5000);
  if (!answer) return null;

  return prisma.reviewItem.upsert({
    where: { userId_questionId: { userId: input.userId, questionId: input.questionId } },
    create: {
      userId: input.userId,
      questionId: input.questionId,
      prompt: plainText(input.prompt, 5000),
      answer,
      subject: input.subject,
      topic: input.topic || 'General',
      status: 'active',
      nextReviewAt: new Date(),
    },
    update: {
      prompt: plainText(input.prompt, 5000),
      answer,
      subject: input.subject,
      topic: input.topic || 'General',
      status: 'active',
      nextReviewAt: new Date(),
    },
  });
}
import { prisma } from '@/lib/prisma';
