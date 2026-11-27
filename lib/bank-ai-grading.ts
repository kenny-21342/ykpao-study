import { chatJSON, SYSTEM_PROMPTS } from './ai';
import { graderGuidance, graderMaxTokens, graderNoThinking } from './subject-guidance';
import { requireTextAi, requireVisionAi } from './ai-credentials';
import { checkAiAllowance, recordUsage } from './rate-limit';
import { VISION_GRADE_TOKENS_ESTIMATE } from './vision';
import { hasGradableText, runVisionGrading } from './grading-router';
import type { GradeResult } from '@/types/ai';

/**
 * AI marking for a free-response bank question.
 *
 * The bank used to be self-marked only. A handwritten answer -- written in the
 * answer box with a stylus, autosaved as the per-question scratchpad image --
 * is marked by the vision model together with anything typed; a typed-only
 * answer goes to the text grader. Both use the same examiner guidance as mock
 * exams and practice.
 *
 * Never throws for a provider failure: the caller still saves the attempt,
 * unmarked, and shows `notice` -- losing a student's answer because the
 * marker was down is worse than not marking it.
 */
export type BankAiGrade =
  | {
      graded: true;
      grade: Partial<GradeResult>;
      mode: 'text' | 'vision';
      /** Marked against the published mark scheme text, or without one. */
      official: boolean;
    }
  | { graded: false; notice: string; status?: number };

export async function gradeBankAnswer(params: {
  userId: string;
  questionText: string;
  subject: string;
  totalMarks: number | null;
  typed: string;
  imageUrl: string | null;
  markscheme: string | null;
  budgetMs: number;
}): Promise<BankAiGrade> {
  const { userId, questionText, subject, totalMarks, typed, imageUrl, markscheme } = params;
  // Same gate as every other grader: without the question's text the model
  // marks against nothing and returns a confident zero.
  if (!hasGradableText(questionText)) {
    return { graded: false, notice: 'This question has no text for the AI marker to read yet. Mark it yourself against the mark scheme.' };
  }
  const guidanceInput = { subject, marks: totalMarks, questionText };
  const official = Boolean(markscheme?.trim());

  if (imageUrl) {
    const vision = await requireVisionAi(userId);
    if (!vision.ok) return { graded: false, notice: vision.error };
    const allowance = await checkAiAllowance(userId, { requests: 1, source: vision.source });
    if (!allowance.allowed) return { graded: false, notice: allowance.message, status: 429 };
    try {
      const outcome = await runVisionGrading({
        imageUrl,
        questionText,
        studentText: typed || null,
        markscheme,
        totalMarks,
        credential: vision.credential,
        systemExtra: graderGuidance(guidanceInput) || undefined,
        budgetMs: params.budgetMs,
        requestTimeoutMs: params.budgetMs - 10_000,
      });
      await recordUsage({
        userId,
        feature: outcome.graded ? 'bank-grade-vision' : 'bank-grade-vision:error',
        tokensIn: outcome.graded ? outcome.usage?.tokensIn : undefined,
        tokensOut: outcome.graded
          ? outcome.usage?.tokensOut ?? (outcome.usage ? undefined : VISION_GRADE_TOKENS_ESTIMATE)
          : undefined,
        model: vision.credential.model,
      });
      if (!outcome.graded) {
        return { graded: false, notice: 'The AI marker could not read your handwriting this time. Your answer is saved -- try again, or mark it yourself.' };
      }
      return { graded: true, grade: outcome.grade, mode: 'vision', official };
    } catch (error) {
      await recordUsage({ userId, feature: 'bank-grade-vision:error', model: vision.credential.model });
      return { graded: false, notice: error instanceof Error && error.message ? error.message : 'The AI marker could not be reached.' };
    }
  }

  const text = await requireTextAi(userId);
  if (!text.ok) return { graded: false, notice: text.error };
  const allowance = await checkAiAllowance(userId, { requests: 1, source: text.source });
  if (!allowance.allowed) return { graded: false, notice: allowance.message, status: 429 };
  const servedModel: { current: string | null } = { current: null };
  try {
    const userContent = `Grade the student's answer against the markscheme.

Question:
${questionText}

${markscheme ? `Markscheme:\n${markscheme}\n\n` : ''}${totalMarks ? `Total marks: ${totalMarks}\n\n` : ''}Student answer:
${typed}`;
    const usage: { current: { promptTokens: number; completionTokens: number } | null } = { current: null };
    const grade = await chatJSON<GradeResult>(
      [
        { role: 'system', content: SYSTEM_PROMPTS.grader + graderGuidance(guidanceInput) },
        { role: 'user', content: userContent },
      ],
      {
        credential: text.credential,
        temperature: 0.2,
        maxTokens: graderMaxTokens(guidanceInput, 1500),
        noThinking: graderNoThinking(guidanceInput),
        onUsage: (u) => { usage.current = u; },
        onModel: (m) => { servedModel.current = m; },
      },
    );
    await recordUsage({
      userId,
      feature: 'bank-grade',
      tokensIn: usage.current?.promptTokens ?? Math.ceil(userContent.length / 4),
      tokensOut: usage.current?.completionTokens ?? 800,
      model: servedModel.current ?? text.credential.model,
    });
    if (!grade || Object.keys(grade).length === 0) {
      return { graded: false, notice: 'The AI marker returned nothing this time. Your answer is saved -- try again, or mark it yourself.' };
    }
    return { graded: true, grade, mode: 'text', official };
  } catch (error) {
    await recordUsage({ userId, feature: 'bank-grade:error', model: servedModel.current ?? text.credential.model });
    return { graded: false, notice: error instanceof Error && error.message ? error.message : 'The AI marker could not be reached.' };
  }
}

export { aiVerdictFrom, bankGradeFields, type BankAiVerdict } from './bank-grade-fields';
