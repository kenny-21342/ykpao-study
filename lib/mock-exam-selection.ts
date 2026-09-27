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
 * Paper *shape* is no longer lost, though it was for a year. A request naming
 * a paper number is built from a blueprint measured over the real papers of
 * that subject -- see `lib/paper-templates.ts` -- so a Paper 4 is nine
 * questions of about eight marks in that order rather than whatever adds up.
 * A request with no paper number still packs to a mark total, which is what
 * `selectBankQuestions` below does.
 *
 * What is still lost is topic-aware curation. That was written when `bank_topics`
 * had no rows. Tagging has been running since, so the topic filter below does
 * bite for the subjects it has reached -- 271 topics over 39% of published
 * questions on 27 Sep, and rising while the pass continues, so treat any
 * figure written here as a floor rather than a measurement. Weighting a paper
 * across topics is still not done. Difficulty is now filled on about 15% of
 * published questions (it was 44 rows on 25 Sep), which is enough to be worth
 * revisiting as a selection input and was not before.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { fillSlots, packToTarget, type SelectedQuestion } from '@/lib/mock-exam-packing';
import type { PaperTemplate } from '@/lib/paper-templates';

export { fillSlots, packToTarget, totalMarksOf } from '@/lib/mock-exam-packing';
export type { SelectedQuestion } from '@/lib/mock-exam-packing';

/**
 * How many candidates to pull before packing.
 *
 * Packing needs slack: drawing exactly the number of questions a paper holds
 * would let one 12-mark question overshoot a 20-mark target with nothing
 * smaller left to try. Ten times the ceiling is enough for the greedy pass
 * below to find a close fit, and is still one indexed query. Sized against the
 * largest paper the caps allow (60 one-mark questions), not the smallest.
 */
const CANDIDATE_POOL = 500;

/**
 * Draw a paper's worth of questions for a subject.
 *
 * Randomised in SQL so two students asking for the same subject do not sit the
 * same paper, and so one student can regenerate for a different one. Only
 * published questions with a published mark scheme carrying a mark total are
 * eligible: a question we cannot mark or weight has no place in something
 * presented as an exam.
 *
 * The total may come from either side. A multiple-choice key stamps 1 on the
 * mark scheme; a structured question gets its total from the allocation printed
 * on the question paper, which `pdf_extraction/bank/marks.py` reads into
 * `bank_questions.totalMarks`. Requiring the mark-scheme column alone is what
 * restricted every generated paper to multiple choice.
 */
export async function selectBankQuestions(options: {
  subjectCodes: string[];
  targetMarks: number;
  maxItems: number;
  /** How many chosen questions may lack an answer key. Defaults to `maxItems`. */
  maxUnkeyedItems?: number;
  /**
   * Restrict the draw to one paper number.
   *
   * A mock exam does not care -- it wants a spread of the subject. A predicted
   * paper does: it is shaped after the observed structure of, say, Paper 2, and
   * drawing Paper 1 multiple choice into it would contradict the blueprint it
   * just described. Left undefined the draw is unrestricted, which is what
   * every existing caller wants.
   */
  paperNumber?: number | null;
}): Promise<SelectedQuestion[]> {
  const { subjectCodes, targetMarks, maxItems, maxUnkeyedItems, paperNumber } = options;
  if (subjectCodes.length === 0 || maxItems <= 0) return [];

  const candidates = await prisma.$queryRaw<
    Array<{ id: number; marks: number; paperId: number; year: number; keyed: boolean }>
  >(Prisma.sql`
    SELECT q.id,
           COALESCE(m."totalMarks", q."totalMarks") AS marks,
           p.id AS "paperId", p.year,
           (m."answerLetter" IS NOT NULL) AS keyed
    FROM bank_questions q
    JOIN bank_papers p ON p.id = q."paperId"
    JOIN bank_subjects s ON s.id = p."subjectId"
    JOIN bank_mark_schemes m ON m."questionId" = q.id
    WHERE q.status = 'published'
      AND m.status = 'published'
      AND COALESCE(m."totalMarks", q."totalMarks") > 0
      AND p."docType" = 'qp'
      AND s.code IN (${Prisma.join(subjectCodes)})
      ${typeof paperNumber === 'number' ? Prisma.sql`AND p."paperNumber" = ${paperNumber}` : Prisma.empty}
    ORDER BY random()
    LIMIT ${CANDIDATE_POOL}
  `);

  return packToTarget(candidates, targetMarks, maxItems, maxUnkeyedItems ?? maxItems);
}


/**
 * The subjects generation can actually serve.
 *
 * The form used to fill its dropdown from `/api/questions?action=filters`,
 * which lists legacy `subjects` having any *paper* -- and papers exist for all
 * eight enrolled subjects while questions do not. So the picker offered
 * Additional Mathematics, the student picked it, and generation failed. The
 * predicate below is deliberately the same one `selectBankQuestions` draws
 * against, so a subject can never be offered that the draw would then come up
 * empty on.
 */
export async function listServableSubjects(
  subjectCodes: string[] | null,
): Promise<Array<{ id: number; code: string; name: string }>> {
  if (subjectCodes && subjectCodes.length === 0) return [];

  return prisma.$queryRaw<Array<{ id: number; code: string; name: string }>>(Prisma.sql`
    SELECT DISTINCT s.id, s.code, s.name
    FROM bank_questions q
    JOIN bank_papers p ON p.id = q."paperId"
    JOIN bank_subjects s ON s.id = p."subjectId"
    JOIN bank_mark_schemes m ON m."questionId" = q.id
    WHERE q.status = 'published'
      AND m.status = 'published'
      AND COALESCE(m."totalMarks", q."totalMarks") > 0
      AND p."docType" = 'qp'
      ${subjectCodes ? Prisma.sql`AND s.code IN (${Prisma.join(subjectCodes)})` : Prisma.empty}
    ORDER BY s.name ASC
  `);
}

/**
 * Fill a real paper's shape with real questions.
 *
 * `selectBankQuestions` above packs to a mark total, which gets the weight
 * right and the shape wrong: it will answer "80 marks of Physics" with eighty
 * one-mark multiple-choice questions, or drop a multiple-choice question into
 * the middle of a structured paper. This walks a blueprint from
 * `lib/paper-templates.ts` instead -- nine questions of eight marks, in that
 * order, because that is what Paper 4 has been for sixty-eight sittings.
 *
 * Matching is widened in steps rather than all at once. An exact mark match is
 * what makes the paper look right, so it is tried for every slot first; only a
 * slot that cannot be filled exactly settles for a near miss, and only then
 * for anything. Widening slot by slot would let an early slot take a question
 * a later, pickier slot needed.
 */
export async function selectByTemplate(options: {
  subjectCodes: string[];
  template: PaperTemplate;
}): Promise<SelectedQuestion[]> {
  const { subjectCodes, template } = options;
  if (subjectCodes.length === 0) return [];

  const candidates = await prisma.$queryRaw<
    Array<{ id: number; marks: number; paperId: number; year: number; keyed: boolean }>
  >(Prisma.sql`
    SELECT q.id,
           COALESCE(m."totalMarks", q."totalMarks") AS marks,
           p.id AS "paperId", p.year,
           (m."answerLetter" IS NOT NULL) AS keyed
    FROM bank_questions q
    JOIN bank_papers p ON p.id = q."paperId"
    JOIN bank_subjects s ON s.id = p."subjectId"
    LEFT JOIN bank_mark_schemes m ON m."questionId" = q.id
    WHERE q.status = 'published'
      AND COALESCE(m."totalMarks", q."totalMarks") > 0
      AND p."docType" = 'qp'
      AND p."paperNumber" = ${template.paperNumber}
      AND s.code IN (${Prisma.join(subjectCodes)})
      ${template.style === 'mcq'
        ? Prisma.sql`AND m."answerLetter" IS NOT NULL`
        : Prisma.empty}
    ORDER BY random()
    LIMIT ${TEMPLATE_POOL}
  `);

  return fillSlots(template.slots, candidates);
}

/**
 * How many candidates to draw before filling.
 *
 * A template can ask for 38 slots (a multiple-choice paper) and each wants a
 * specific mark value, so the pool has to be deep in every bucket rather than
 * merely large. Every group measured on 27 Sep held at least three times the
 * questions its own shape needs, and this is well past that.
 */
const TEMPLATE_POOL = 900;
