/**
 * On-demand transcription of crop-first bank questions.
 *
 * The bank stores a question as cropped images and leaves `bodyMd` empty:
 * 66,756 published questions, none with any text. `lib/bank-questions.ts`
 * states what that costs -- everything that reasons over a question rather
 * than displaying it (hints, AI grading, search) needs the transcript and is
 * gated off without it -- and the sweep that added `decideGradingMode`'s
 * `hasQuestionText` gate proved why the gate has to stay: marking against an
 * empty question produced confident zeros.
 *
 * This is the way back in. The first student who submits an answer to a
 * question pays for one transcription pass over its strips; the result is
 * written to `bodyMd` (and `answerMd` where the mark scheme is image-only) and
 * indexed, so every student after them pays nothing, and the same question
 * becomes searchable and hint-able at the same moment. That is the trade
 * against shipping strips to the model on every grade: paid once per question
 * rather than once per attempt, and it unlocks more than vision grading.
 *
 * A bulk pass over a whole subject is a better deal per question and belongs
 * in the Python extraction pipeline, not here. The two compose -- they fill
 * the same column -- so this stays the fallback for whatever the bulk pass
 * has not reached.
 */

import { prisma } from '@/lib/prisma';
import { recordUsage } from '@/lib/rate-limit';
import { indexBankQuestion, refreshRagIndex } from '@/lib/rag-index';
import { transcribeBankMarkScheme, transcribeBankQuestion } from '@/lib/vision';
import type { VisionCredential } from '@/lib/ai-credentials';

/**
 * What one question's transcription is allowed to spend.
 *
 * Sized like a grading call, not like OCR. `lib/vision.ts` already records why
 * the distinction matters: its default 15s per-attempt ceiling is deliberately
 * short because a failed transcription of a student's handwriting costs the
 * caller nothing, and a call that writes a long response runs past it. Reading
 * a printed exam question is the long kind -- part labels, mark allocations,
 * a described figure -- and at the OCR ceiling every attempt aborted mid-flight
 * and every question fell to the ungraded branch, which looked exactly like
 * the feature not being deployed.
 *
 * The caller bounds how many of these one submission may pay for; this bounds
 * how long each may take. Two calls (question, mark scheme) share the budget.
 */
const TRANSCRIBE_BUDGET_MS = Number(process.env.BANK_TRANSCRIBE_BUDGET_MS || 45_000);
const TRANSCRIBE_REQUEST_TIMEOUT_MS = 40_000;

/**
 * Off by default, because the call does not fit where it is currently made.
 *
 * Measured against the production model (Qwen3-VL-32B on SiliconFlow) with a
 * real 4-strip question: 200 OK, a correct transcript with part labels, mark
 * allocations and a bracketed figure description -- in **84 seconds**. A
 * single strip took 31. The corpus averages 1.85 strips and reaches 5 at the
 * 95th percentile, so a large share of first touches cannot finish inside any
 * per-attempt ceiling a student will sit through, and every one that misses is
 * paid for and thrown away.
 *
 * Nothing about the transcription itself is wrong -- the prompt, the
 * multi-image payload and the persistence all work. What is wrong is doing it
 * synchronously inside the request the student is waiting on, where it also
 * competes for the invocation with the grading it exists to enable. The fix is
 * to move it after the response (`after()`), grade this attempt on the
 * existing ungraded path, and let the *next* attempt on that question be the
 * one that benefits -- which is what "paid once per question" always meant.
 *
 * Until that lands, this flag keeps production on exactly the behaviour it had
 * before: an honest "not transcribed yet" notice, and no spend.
 */
const TRANSCRIBE_ENABLED = process.env.BANK_TRANSCRIBE === 'on';

export type BankTranscription = {
  /** The question text, always non-empty when this is returned. */
  bodyMd: string;
  /** The mark scheme text, when one was already stored or has just been read. */
  answerMd: string | null;
};

/**
 * Return a bank question's text, transcribing its strips once if it has none.
 *
 * Returns null when there is no text and none can be produced -- no vision
 * credential, no resolvable strips, a failed provider call. Callers must treat
 * that exactly as they treat an untranscribed question today: route to the
 * ungraded branch and record the attempt honestly. Never as an empty
 * transcript, which is the failure the `hasQuestionText` gate exists to stop.
 */
export async function ensureBankQuestionText(params: {
  questionId: number;
  /** Strip URLs in reading order, server-derived (`normalizeExamItem`). */
  strips: string[];
  /** The mark scheme's strips, if it has any and no text of its own. */
  markschemeStrips?: string[];
  /** Text already stored for the question, if any. */
  bodyMd?: string | null;
  /** Text already stored for the mark scheme, if any. */
  answerMd?: string | null;
  credential: VisionCredential | null;
  userId: string;
}): Promise<BankTranscription | null> {
  const existingBody = params.bodyMd?.trim() ?? '';
  const existingAnswer = params.answerMd?.trim() ?? '';
  if (existingBody) return { bodyMd: existingBody, answerMd: existingAnswer || null };

  if (!TRANSCRIBE_ENABLED) return null;
  if (!params.credential) return null;
  if (params.strips.length === 0) return null;

  const deadline = Date.now() + TRANSCRIBE_BUDGET_MS;
  const credential = params.credential;

  const question = await transcribeBankQuestion(params.strips, credential, {
    budgetMs: TRANSCRIBE_BUDGET_MS,
    requestTimeoutMs: TRANSCRIBE_REQUEST_TIMEOUT_MS,
  });
  if (!question || !question.text.trim()) return null;
  const bodyMd = question.text.trim();

  await recordUsage({
    userId: params.userId,
    feature: 'bank-transcribe',
    tokensIn: question.usage?.tokensIn,
    tokensOut: question.usage?.tokensOut,
    model: credential.model,
  });

  // The mark scheme is a second call and a second cost, so only make it when
  // there is no text at all and there are strips to read. Failing it is not
  // fatal: a transcribed question with an image-only mark scheme still grades
  // better than no question at all.
  let answerMd: string | null = existingAnswer || null;
  const markschemeStrips = params.markschemeStrips ?? [];
  if (!answerMd && markschemeStrips.length > 0 && Date.now() < deadline - 2_000) {
    const markScheme = await transcribeBankMarkScheme(markschemeStrips, credential, {
      budgetMs: Math.max(2_000, deadline - Date.now()),
      requestTimeoutMs: TRANSCRIBE_REQUEST_TIMEOUT_MS,
    });
    if (markScheme?.text.trim()) {
      answerMd = markScheme.text.trim();
      await recordUsage({
        userId: params.userId,
        feature: 'bank-transcribe:markscheme',
        tokensIn: markScheme.usage?.tokensIn,
        tokensOut: markScheme.usage?.tokensOut,
        model: credential.model,
      });
    }
  }

  await persist(params.questionId, bodyMd, answerMd, Boolean(existingAnswer));

  return { bodyMd, answerMd };
}

/**
 * Write the transcription back, then re-index.
 *
 * The update is conditional on `bodyMd` still being empty, so two students
 * submitting the same question at the same moment cannot overwrite each
 * other: the loser's transcription is simply discarded. Both then return
 * their own text, which is the same question read twice -- close enough, and
 * cheaper than locking.
 *
 * Persisting is the entire point of doing this on demand rather than per
 * attempt, and re-indexing is what turns a paid transcription into a
 * searchable question rather than only a gradeable one. Neither may fail the
 * submission that triggered it.
 */
async function persist(
  questionId: number,
  bodyMd: string,
  answerMd: string | null,
  answerAlreadyStored: boolean,
): Promise<void> {
  try {
    await prisma.bankQuestion.updateMany({
      where: { id: questionId, bodyMd: '' },
      data: { bodyMd },
    });

    if (answerMd && !answerAlreadyStored) {
      await prisma.bankMarkScheme.updateMany({
        where: { questionId, answerMd: '' },
        data: { answerMd },
      });
    }
  } catch (err) {
    console.warn('bank-transcription: failed to persist', questionId, err);
    return;
  }

  await refreshRagIndex(`bank-question:${questionId}`, () => indexBankQuestion(questionId));
}
