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
 * The blueprint's *marks* are no longer ours either. Measuring them from our
 * own extraction was wrong for 160 of 187 paper groups, sometimes absurdly:
 * IGCSE History Paper 4 measured 520 marks against an official 40, because
 * every question in it carries the paper's own total. So the board's figures
 * are overlaid on the measured ladder -- Cambridge's from the published
 * syllabus, the IB's read off its papers' cover pages, see
 * `lib/paper-format-overlay.ts`. A generated paper now adds up to the number
 * printed on the real cover and runs for the time printed beside it.
 *
 * Where our extraction merged a whole paper into one question -- 19 groups,
 * mostly IB Mathematics -- there is no credible ladder to correct, and the
 * blueprint is dropped rather than turned into a single 110-mark question.
 * Those subjects pack to a mark total, as every subject did before.
 *
 * Topic weighting is done too, as of 28 Sep, and it is the last of the three
 * things a generated paper was missing. The tagging pass finished that morning
 * and its output is merged: 539 topics, and on the questions this module can
 * actually draw -- published, with a published mark scheme and a mark total --
 * coverage is 93-100% for twenty-one of the twenty-four subjects with more than
 * 200 eligible questions, better than the 90.1% figure for the corpus as a
 * whole. The exceptions are 0450 at 87% and the two History syllabuses, 0460 and
 * 0470, at 35.6% and 39.4%; `MIN_TOPIC_COVERAGE` is what keeps those two out.
 *
 * The weights are measured, not declared. `listTopicWeights` counts how a
 * subject's own eligible marks fall across its topics, which for IGCSE Physics
 * gives Motion/forces/energy 33.1%, Electricity and magnetism 26.6%, Waves
 * 19.7%, Thermal 15.9%, Nuclear 4.2% and Space 0.5% -- the syllabus, observed
 * rather than asserted, exactly as `lib/paper-templates.ts` measures paper
 * shape from real papers instead of trusting a specification. Declared
 * weightings exist, but in prose, in 49 syllabuses, in 49 formats.
 *
 * Both draws use them: the mark-total pack and the blueprint fill each prefer
 * a question whose topic still has room. Neither can be made worse by it -- the
 * allowance decides which question is preferred, never whether a paper reaches
 * its target or fills its slots, and a subject whose tagging is too thin packs
 * exactly as it did before.
 *
 * Measured over 150 papers a side on the nine largest subjects, holding the rest
 * of the packer constant so the comparison is the weighting and not the mark fix
 * below: the heaviest topic's share of a paper fell from 22-45% to 9-36%,
 * improving on seven subjects and flat on two, and topics per paper rose on all
 * nine, from 3.9-9.0 to 4.3-11.9. Marks stayed at the full 50 on eight of the
 * nine; IB Biology came back at 47, because preferring a topic changes which
 * question the greedy pass takes and the arithmetic can land a little short. A
 * paper three marks under target is still a paper, so that is the accepted
 * price, not an unnoticed regression.
 *
 * Doing this also surfaced a separate, pre-existing defect and fixed it: a
 * "50-mark paper" was coming back holding 26 to 42 marks depending on the
 * subject, because the packer took questions in draw order out of a bank that is
 * three quarters one-mark multiple choice. See `packToTarget`.
 *
 * `lib/feature-readiness.ts` says this to students; keep the two in step.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  fillSlots,
  packToTarget,
  topicShares,
  type SelectedQuestion,
  type TopicWeight,
} from '@/lib/mock-exam-packing';
import type { PaperTemplate } from '@/lib/paper-templates';

export { fillSlots, packToTarget, topicAllowance, topicShares, totalMarksOf } from '@/lib/mock-exam-packing';
export type { SelectedQuestion, TopicWeight } from '@/lib/mock-exam-packing';

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
    Array<{ id: number; marks: number; paperId: number; year: number; keyed: boolean; topicId: number | null }>
  >(Prisma.sql`
    SELECT q.id,
           COALESCE(m."totalMarks", q."totalMarks") AS marks,
           p.id AS "paperId", p.year,
           (m."answerLetter" IS NOT NULL) AS keyed,
           qt."topicId" AS "topicId"
    FROM bank_questions q
    JOIN bank_papers p ON p.id = q."paperId"
    JOIN bank_subjects s ON s.id = p."subjectId"
    JOIN bank_mark_schemes m ON m."questionId" = q.id
    LEFT JOIN LATERAL (
      SELECT bt."topicId"
      FROM bank_question_topics bt
      WHERE bt."questionId" = q.id
      -- One topic per question, and the same one every time. Most questions
      -- have exactly one; where there are several the tagging pass's own
      -- confidence decides, with the id breaking ties so a paper generated
      -- twice balances against the same topic rather than drifting.
      ORDER BY bt.confidence DESC, bt."topicId" ASC
      LIMIT 1
    ) qt ON TRUE
    WHERE q.status = 'published'
      AND m.status = 'published'
      AND COALESCE(m."totalMarks", q."totalMarks") > 0
      AND p."docType" = 'qp'
      AND s.code IN (${Prisma.join(subjectCodes)})
      ${typeof paperNumber === 'number' ? Prisma.sql`AND p."paperNumber" = ${paperNumber}` : Prisma.empty}
    ORDER BY random()
    LIMIT ${CANDIDATE_POOL}
  `);

  const weights = await listTopicWeights(subjectCodes);
  return packToTarget(
    candidates,
    targetMarks,
    maxItems,
    maxUnkeyedItems ?? maxItems,
    // Tagging too thin to weight against means no allowances, and the draw
    // spreads on paper and size alone -- see `MIN_TOPIC_COVERAGE`.
    weights.length > 0 ? topicShares(weights) : undefined,
  );
}


/**
 * How much of a subject must be tagged before its measured weights are used.
 *
 * Topic weights are a distribution measured off the tagged questions, so they
 * are only the syllabus if the tagged questions are most of the bank. Coverage
 * across the corpus is sharply bimodal: two subjects sit at 35.6% and 39.4%
 * (0460 and 0470, both History), one at 87%, and the other twenty-one are all
 * above 93%. There is nothing in between, so this threshold is drawn through
 * the empty gap rather than tuned.
 *
 * It matters because a question with no topic can only be taken in the
 * unbalanced tiers of `packToTarget`. At 96% tagged that is the 4% tail behaving
 * exactly as intended. At 39% it means three fifths of the bank is relegated,
 * and measured over 40 papers it cost IGCSE History two marks and four of its
 * seven questions -- balancing a paper against a distribution that describes a
 * biased minority of it. Below this line a subject is packed unbalanced, which
 * is honest: the weights are not yet known.
 */
const MIN_TOPIC_COVERAGE = 2 / 3;

/**
 * How a subject's marks are distributed across its topics, measured.
 *
 * Not declared anywhere, and deliberately so. An exam board publishes topic
 * weightings in prose across 49 syllabuses in 49 formats; the bank already
 * holds the answer in a form we can count. Over the 7,205 eligible IGCSE
 * Physics questions the split is Motion/forces/energy 33.1%, Electricity and
 * magnetism 26.6%, Waves 19.7%, Thermal 15.9%, Nuclear 4.2%, Space 0.5% --
 * which is the syllabus, observed rather than asserted, the same way
 * `lib/paper-templates.ts` measures paper shape from real papers instead of
 * trusting a specification.
 *
 * The predicate matches `selectBankQuestions` exactly. Weighting against a
 * different population than the one being drawn from would set allowances the
 * draw could not fill -- for instance counting unpublished questions, whose
 * topics are tagged but which no paper can ever contain.
 *
 * Returns an empty array when the tagging is too thin to be worth trusting,
 * and the caller then packs unbalanced, exactly as before this existed. See
 * `MIN_TOPIC_COVERAGE` for why that threshold exists at all.
 */
/**
 * Measured weights, cached per instance, following `lib/paper-templates.ts`.
 *
 * Same argument as there, and the same numbers: this is an aggregate over every
 * eligible question in a subject, it measures ~450ms against production, and
 * what it measures only moves when a tagging or extraction pass lands -- days
 * apart. Paying it on every generation would be half a second of a student's
 * wait for an answer that cannot have changed. Concurrent misses share one
 * query.
 */
const WEIGHTS_TTL_MS = 60 * 60 * 1000;
const weightsCache = new Map<string, { at: number; weights: TopicWeight[] }>();
const weightsInFlight = new Map<string, Promise<TopicWeight[]>>();

/** Clears the memo. Tests only. */
export function resetTopicWeightCache(): void {
  weightsCache.clear();
  weightsInFlight.clear();
}

export async function listTopicWeights(subjectCodes: string[]): Promise<TopicWeight[]> {
  if (subjectCodes.length === 0) return [];

  // Sorted, so one subject list cached under two orderings is one entry.
  const key = [...subjectCodes].sort().join('\u0000');
  const hit = weightsCache.get(key);
  if (hit && Date.now() - hit.at < WEIGHTS_TTL_MS) return hit.weights;
  const existing = weightsInFlight.get(key);
  if (existing) return existing;

  const pending = measureTopicWeights(subjectCodes)
    .then((weights) => {
      weightsCache.set(key, { at: Date.now(), weights });
      return weights;
    })
    .catch((error: unknown) => {
      console.error('[mock-exam] could not measure topic weights for %s:', key, error);
      // An unbalanced paper is the behaviour that shipped for a year. A failed
      // measurement must degrade to it, never fail the generation.
      return weightsCache.get(key)?.weights ?? [];
    })
    .finally(() => {
      weightsInFlight.delete(key);
    });

  weightsInFlight.set(key, pending);
  return pending;
}

async function measureTopicWeights(subjectCodes: string[]): Promise<TopicWeight[]> {
  const rows = await prisma.$queryRaw<
    Array<{ topicId: number | null; marks: number; questions: number }>
  >(Prisma.sql`
    SELECT qt."topicId" AS "topicId",
           SUM(COALESCE(m."totalMarks", q."totalMarks"))::int AS marks,
           COUNT(*)::int AS questions
    FROM bank_questions q
    JOIN bank_papers p ON p.id = q."paperId"
    JOIN bank_subjects s ON s.id = p."subjectId"
    JOIN bank_mark_schemes m ON m."questionId" = q.id
    -- The same one-topic-per-question pick the draw itself makes, so a
    -- question tagged with three topics is one question here too, and the
    -- coverage figure below counts questions rather than taggings.
    LEFT JOIN LATERAL (
      SELECT bt."topicId"
      FROM bank_question_topics bt
      WHERE bt."questionId" = q.id
      ORDER BY bt.confidence DESC, bt."topicId" ASC
      LIMIT 1
    ) qt ON TRUE
    WHERE q.status = 'published'
      AND m.status = 'published'
      AND COALESCE(m."totalMarks", q."totalMarks") > 0
      AND p."docType" = 'qp'
      AND s.code IN (${Prisma.join(subjectCodes)})
    GROUP BY qt."topicId"
  `);

  const eligible = rows.reduce((sum, row) => sum + row.questions, 0);
  if (eligible === 0) return [];
  const tagged = rows
    .filter((row) => row.topicId !== null)
    .reduce((sum, row) => sum + row.questions, 0);
  if (tagged / eligible < MIN_TOPIC_COVERAGE) return [];

  const total = rows
    .filter((row) => row.topicId !== null)
    .reduce((sum, row) => sum + row.marks, 0);
  if (total === 0) return [];
  return rows
    .filter((row): row is { topicId: number; marks: number; questions: number } =>
      row.topicId !== null,
    )
    .map((row) => ({ topicId: row.topicId, share: row.marks / total }));
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
    Array<{ id: number; marks: number; paperId: number; year: number; keyed: boolean; topicId: number | null }>
  >(Prisma.sql`
    SELECT q.id,
           COALESCE(m."totalMarks", q."totalMarks") AS marks,
           p.id AS "paperId", p.year,
           (m."answerLetter" IS NOT NULL) AS keyed,
           qt."topicId" AS "topicId"
    FROM bank_questions q
    JOIN bank_papers p ON p.id = q."paperId"
    JOIN bank_subjects s ON s.id = p."subjectId"
    LEFT JOIN bank_mark_schemes m ON m."questionId" = q.id
    LEFT JOIN LATERAL (
      SELECT bt."topicId"
      FROM bank_question_topics bt
      WHERE bt."questionId" = q.id
      -- One topic per question, and the same one every time. Most questions
      -- have exactly one; where there are several the tagging pass's own
      -- confidence decides, with the id breaking ties so a paper generated
      -- twice balances against the same topic rather than drifting.
      ORDER BY bt.confidence DESC, bt."topicId" ASC
      LIMIT 1
    ) qt ON TRUE
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

  const weights = await listTopicWeights(subjectCodes);
  return fillSlots(
    template.slots,
    candidates,
    weights.length > 0 ? topicShares(weights) : undefined,
  );
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
