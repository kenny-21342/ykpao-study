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

export function plainText(value: string, maxLength = 500) {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export async function upsertMistakeReview(input: {
  userId: string;
  questionId: number;
  prompt: string;
  answer?: string | null;
  fallbackAnswer?: string | null;
  subject: string;
  topic: string;
}) {
  const answer = plainText(
    input.answer || input.fallbackAnswer || 'Rework this question and compare each step with the mark scheme.',
    5000
  );

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
