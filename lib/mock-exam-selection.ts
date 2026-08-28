/**
 * Choosing the questions that make up a mock exam.
 *
 * This used to be one LLM call over a candidate list. Two things were wrong
 * with that. It read the *legacy* `past_paper_questions` table, which holds
 * 21-43 rows for the three science subjects and zero for everything else, so
 * five of eight enrolled subjects returned "No questions available for this
 * subject in the bank" while the crop-first bank held thousands. And selecting
 * from a list is not a judgement a model is needed for: it is a sample, and
 * asking a provider whose median call is 7-27 seconds to draw one meant
 * generation timed out and the paper landed in `failed`.
 *
 * So selection is now a query. It reads `bank_questions` -- the corpus the
 * pipeline actually fills -- and packs a paper to the requested mark total.
 * That makes generation synchronous and free, and removes the `generating`
 * state, the client poll, and the whole timeout failure mode with it.
 *
 * What is lost is topic-aware curation. `bank_topics` has no rows yet, so
 * there was nothing to curate against in any case; when tagging lands, the
 * topic filter below starts biting and this can grow a weighting pass.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { packToTarget, type SelectedQuestion } from '@/lib/mock-exam-packing';

export { packToTarget, totalMarksOf } from '@/lib/mock-exam-packing';
export type { SelectedQuestion } from '@/lib/mock-exam-packing';

/**
 * How many candidates to pull before packing.
 *
 * Packing needs slack: drawing exactly the number of questions a paper holds
 * would let one 12-mark question overshoot a 20-mark target with nothing
 * smaller left to try. Ten times the ceiling is enough for the greedy pass
 * below to find a close fit, and is still one indexed query.
 */
const CANDIDATE_POOL = 200;

/**
 * Draw a paper's worth of questions for a subject.
 *
 * Randomised in SQL so two students asking for the same subject do not sit the
 * same paper, and so one student can regenerate for a different one. Only
 * published questions with a published mark scheme carrying a mark total are
 * eligible: a question we cannot mark or weight has no place in something
 * presented as an exam.
 */
export async function selectBankQuestions(options: {
  subjectCodes: string[];
  targetMarks: number;
  maxItems: number;
}): Promise<SelectedQuestion[]> {
  const { subjectCodes, targetMarks, maxItems } = options;
  if (subjectCodes.length === 0 || maxItems <= 0) return [];

  const candidates = await prisma.$queryRaw<
    Array<{ id: number; marks: number; paperId: number; year: number }>
  >(Prisma.sql`
    SELECT q.id, m."totalMarks" AS marks, p.id AS "paperId", p.year
    FROM bank_questions q
    JOIN bank_papers p ON p.id = q."paperId"
    JOIN bank_subjects s ON s.id = p."subjectId"
    JOIN bank_mark_schemes m ON m."questionId" = q.id
    WHERE q.status = 'published'
      AND m.status = 'published'
      AND m."totalMarks" IS NOT NULL
      AND m."totalMarks" > 0
      AND p."docType" = 'qp'
      AND s.code IN (${Prisma.join(subjectCodes)})
    ORDER BY random()
    LIMIT ${CANDIDATE_POOL}
  `);

  return packToTarget(candidates, targetMarks, maxItems);
}

