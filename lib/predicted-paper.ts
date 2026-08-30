import { chatJSON } from '@/lib/ai';
import type { TextCredential } from '@/lib/ai-credentials';
import { toBankSubjectCodes } from '@/lib/bank-questions';
import { plainText } from '@/lib/learning';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import { MAX_EXAM_ITEMS, MAX_KEYED_EXAM_ITEMS } from '@/lib/mock-exam-limits';
import { listServableSubjects, selectBankQuestions, totalMarksOf } from '@/lib/mock-exam-selection';

type QuestionType = 'short-answer' | 'structured' | 'extended';

type CandidateQuestion = Awaited<ReturnType<typeof loadCandidateQuestions>>[number];

type PredictedSection = {
  title: string;
  questionIds: number[];
  rationale?: string;
};

type PredictedPaperAIPlan = {
  title: string;
  description: string;
  durationMinutes: number;
  totalMarks: number;
  confidence: 'low' | 'medium' | 'high';
  blueprintSummary: string;
  syllabusCoverage: string[];
  sections: PredictedSection[];
  markSchemeGuide: Array<{
    questionId: number;
    markingFocus: string;
    expectedSkills: string[];
  }>;
};

export type PredictedPaperResult = {
  exam: {
    id: string;
    title: string;
    subjectCode: string;
    questionCount: number;
    totalMarks: number;
  };
  prediction: {
    confidence: 'low' | 'medium' | 'high';
    blueprintSummary: string;
    syllabusCoverage: string[];
    markSchemeGuide: PredictedPaperAIPlan['markSchemeGuide'];
    observedPaperCount: number;
    paperNumber: number | null;
    questionTypeMix: Record<QuestionType, number>;
  };
};

export type PredictedPaperOptions = {
  userId: string;
  /**
   * Whose key pays for the plan. Resolved by the caller so this stays a pure
   * library function — there is no server key to fall back to.
   */
  credential: TextCredential;
  subjectCode: string;
  topics?: string[];
  totalMarks?: number;
  durationMinutes?: number;
  difficulty?: string;
  questionCount?: number;
  paperNumber?: number;
  title?: string;
};

const MAX_CANDIDATES = 70;

/**
 * How much legacy coverage a subject needs before a model is asked to curate.
 *
 * The two corpora are not interchangeable. `past_paper_questions` carries the
 * question *text* the predicted-paper prompt reasons over, and has real depth
 * for the IB subjects (Chemistry 2,145 usable questions, Physics 1,531). The
 * crop-first bank has the opposite shape: 66,756 published questions and, as
 * of this writing, `bodyMd` empty on every one of them -- the questions are
 * images. A model handed that bank receives ids, years and mark counts with
 * empty previews, and can contribute nothing a query does not already do.
 *
 * So the split is by capability rather than preference: curate where there is
 * text to curate, and assemble deterministically where there is not. Below
 * this floor the legacy table cannot fill a paper anyway -- Additional
 * Mathematics has 0 usable legacy questions and 140 papers, which is exactly
 * how "Generate Predicted Paper" came to fail for every CAIE subject.
 */
const MIN_LEGACY_CANDIDATES = 60;

const PREDICTED_PAPER_PROMPT = `You are an expert examiner creating predicted practice papers from a provided question bank and observed historical paper structure.

Return JSON only. Do not invent question IDs. Pick ONLY from the provided candidate IDs.

Schema:
{
  "title": string,
  "description": string,
  "durationMinutes": number,
  "totalMarks": number,
  "confidence": "low" | "medium" | "high",
  "blueprintSummary": string,
  "syllabusCoverage": string[],
  "sections": [
    {
      "title": string,
      "questionIds": number[],
      "rationale": string
    }
  ],
  "markSchemeGuide": [
    {
      "questionId": number,
      "markingFocus": string,
      "expectedSkills": string[]
    }
  ]
}

Rules:
- Build a realistic predicted paper, not a claim about the real future exam.
- Follow the observed paper structure and topic balance as closely as possible.
- Include a useful spread of recall, structured application, and extended questions.
- The markSchemeGuide should summarize how selected questions are marked, using mark-scheme previews when present.
- Keep descriptions concise and student-facing.`;

function questionType(marks: number): QuestionType {
  if (marks <= 3) return 'short-answer';
  if (marks <= 7) return 'structured';
  return 'extended';
}

function median(values: number[], fallback: number) {
  if (values.length === 0) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? fallback;
}

function modeNumber(values: number[]) {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? null;
}

function unique(values: Array<string | null | undefined>, limit = 12) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])].slice(0, limit);
}

async function findMatchingMarkscheme(question: CandidateQuestion) {
  return prisma.pastPaperQuestion.findFirst({
    where: {
      paper: {
        subjectId: question.paper.subjectId,
        year: question.paper.year,
        session: question.paper.session,
        paperNumber: question.paper.paperNumber,
        variant: question.paper.variant,
        docType: 'ms',
      },
      number: question.number,
      part: question.part,
      subPart: question.subPart,
    },
    select: { content: true },
  });
}

async function loadCandidateQuestions(input: {
  subjectId: number;
  paperNumber: number | null;
  topics: string[];
}) {
  const topicFilters = input.topics.flatMap((topic) => [
    { topic: { contains: topic, mode: 'insensitive' as const } },
    { content: { contains: topic, mode: 'insensitive' as const } },
  ]);

  const baseWhere = {
    docType: 'qp',
    marks: { gt: 0 },
    paper: {
      subjectId: input.subjectId,
      docType: 'qp',
      ...(input.paperNumber ? { paperNumber: input.paperNumber } : {}),
    },
  };

  const focused = topicFilters.length
    ? await prisma.pastPaperQuestion.findMany({
        where: { ...baseWhere, OR: topicFilters },
        include: { paper: true },
        orderBy: [{ paper: { year: 'desc' } }, { marks: 'desc' }],
        take: MAX_CANDIDATES,
      })
    : [];

  if (focused.length >= 12 || input.topics.length === 0) {
    if (focused.length > 0) return focused;
  }

  const fallback = await prisma.pastPaperQuestion.findMany({
    where: baseWhere,
    include: { paper: true },
    orderBy: [{ paper: { year: 'desc' } }, { marks: 'desc' }],
    take: MAX_CANDIDATES,
  });

  const seen = new Set<number>();
  return [...focused, ...fallback].filter((question) => {
    if (seen.has(question.id)) return false;
    seen.add(question.id);
    return true;
  }).slice(0, MAX_CANDIDATES);
}

async function buildBlueprint(subjectId: number, requestedPaperNumber?: number) {
  const papers = await prisma.pastPaper.findMany({
    where: {
      subjectId,
      docType: 'qp',
      questions: { some: { docType: 'qp', marks: { gt: 0 } } },
    },
    include: {
      questions: {
        where: { docType: 'qp', marks: { gt: 0 } },
        select: { marks: true, topic: true },
      },
    },
    orderBy: [{ year: 'desc' }, { session: 'desc' }],
    take: 120,
  });

  if (papers.length === 0) throw new Error('No historical paper structure is available for this subject.');

  const paperNumber = requestedPaperNumber ?? modeNumber(papers.map((paper) => paper.paperNumber));
  const relevant = paperNumber ? papers.filter((paper) => paper.paperNumber === paperNumber) : papers;
  const sample = relevant.length > 0 ? relevant : papers;
  const totals = sample.map((paper) => paper.questions.reduce((sum, question) => sum + question.marks, 0)).filter((value) => value > 0);
  const questionCounts = sample.map((paper) => paper.questions.length).filter((value) => value > 0);
  const topicFrequency = new Map<string, number>();
  const questionTypeMix: Record<QuestionType, number> = {
    'short-answer': 0,
    structured: 0,
    extended: 0,
  };

  for (const paper of sample) {
    for (const question of paper.questions) {
      questionTypeMix[questionType(question.marks)] += 1;
      if (question.topic && question.topic !== 'General') {
        topicFrequency.set(question.topic, (topicFrequency.get(question.topic) ?? 0) + 1);
      }
    }
  }

  const frequentTopics = [...topicFrequency.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([topic]) => topic);

  return {
    paperNumber,
    observedPaperCount: sample.length,
    typicalTotalMarks: median(totals, 50),
    typicalQuestionCount: median(questionCounts, 8),
    frequentTopics,
    questionTypeMix,
  };
}

/**
 * 'curated'   — a model picks from legacy questions, whose text it can read.
 * 'assembled' — a query draws from the bank, whose questions are image crops.
 */
export type PredictionPath = 'curated' | 'assembled';

/**
 * Which path each subject's predicted paper will take.
 *
 * One function rather than a rule written out twice, because two callers need
 * the same answer and a disagreement between them is a visible bug: the form
 * would offer Topics and Difficulty for a subject the generator then assembles
 * by query, where neither input reaches anything.
 *
 * Neither corpus is a superset of the other, so the decision has to consult
 * both. Mathematics (9709) is the case that proves it: 55 usable legacy
 * questions -- under the floor -- and *zero* bank questions with a usable mark
 * total, because the mark-extraction pass has not reached it. Routing on the
 * legacy count alone would send it to a bank that cannot serve it at all.
 */
export async function predictionPathsFor(
  catalogCodes: string[],
): Promise<Map<string, PredictionPath>> {
  const paths = new Map<string, PredictionPath>();
  if (catalogCodes.length === 0) return paths;

  const [legacyRows, servable] = await Promise.all([
    prisma.$queryRaw<Array<{ code: string; usable: number }>>(Prisma.sql`
      SELECT s.code, count(q.id)::int AS usable
      FROM subjects s
      JOIN past_papers p ON p."subjectId" = s.id AND p."docType" = 'qp'
      JOIN past_paper_questions q
        ON q."paperId" = p.id AND q."docType" = 'qp' AND q.marks > 0
      WHERE s.code IN (${Prisma.join(catalogCodes)})
      GROUP BY s.code
    `),
    listServableSubjects(toBankSubjectCodes(catalogCodes)),
  ]);

  const legacyCoverage = new Map(legacyRows.map((row) => [row.code, row.usable]));

  for (const code of catalogCodes) {
    if ((legacyCoverage.get(code) ?? 0) >= MIN_LEGACY_CANDIDATES) {
      paths.set(code, 'curated');
      continue;
    }
    const bankCodes = toBankSubjectCodes([code]);
    const servedByBank = servable.some((subject) => bankCodes.includes(subject.code));
    // Thin legacy coverage is still better than a corpus that holds nothing
    // for this subject, so 'curated' is also the answer when the bank is empty.
    paths.set(code, servedByBank ? 'assembled' : 'curated');
  }

  return paths;
}

/**
 * The observed structure of a subject's real papers, read from the bank.
 *
 * Same idea as `buildBlueprint` above, over the corpus that actually holds
 * these subjects. Topics are absent -- `bank_topics` has no rows and no
 * published question carries a difficulty -- so the blueprint is what the data
 * genuinely supports: which paper number this subject is usually sat as, how
 * many marks those papers carry, how many questions, and the spread of
 * question sizes. It does not pretend to a topic breakdown it cannot compute.
 */
async function buildBankBlueprint(subjectCodes: string[], requestedPaperNumber?: number) {
  const rows = await prisma.$queryRaw<
    Array<{ paperId: number; paperNumber: number; marks: number }>
  >(Prisma.sql`
    WITH recent AS (
      SELECT p.id, p.year, p."paperNumber"
      FROM bank_papers p
      JOIN bank_subjects s ON s.id = p."subjectId"
      WHERE p."docType" = 'qp'
        AND s.code IN (${Prisma.join(subjectCodes)})
      ORDER BY p.year DESC, p.id DESC
      LIMIT 120
    )
    SELECT r.id AS "paperId",
           r."paperNumber",
           COALESCE(m."totalMarks", q."totalMarks", 0)::int AS marks
    FROM recent r
    JOIN bank_questions q ON q."paperId" = r.id AND q.status = 'published'
    LEFT JOIN bank_mark_schemes m ON m."questionId" = q.id AND m.status = 'published'
  `);

  // Questions whose mark allocation has not been extracted are counted, but
  // not summed. Keeping both numbers is what lets the paper say honestly that
  // its target is measured from part of a paper rather than all of it.
  const marked = rows.filter((row) => row.marks > 0);
  if (marked.length === 0) return null;

  const paperNumber =
    requestedPaperNumber ?? modeNumber(marked.map((row) => row.paperNumber));

  // Shape the paper after papers of the same number where we have them. A
  // Paper 1 of multiple choice and a Paper 4 of extended response are not the
  // same exam, and averaging them describes neither.
  const scoped = paperNumber ? marked.filter((row) => row.paperNumber === paperNumber) : marked;
  const sample = scoped.length > 0 ? scoped : marked;

  const inScope = paperNumber ? rows.filter((row) => row.paperNumber === paperNumber) : rows;
  const markCoverage = inScope.length > 0 ? sample.length / inScope.length : 1;

  const byPaper = new Map<number, number[]>();
  const questionTypeMix: Record<QuestionType, number> = {
    'short-answer': 0,
    structured: 0,
    extended: 0,
  };
  for (const row of sample) {
    const bucket = byPaper.get(row.paperId);
    if (bucket) bucket.push(row.marks);
    else byPaper.set(row.paperId, [row.marks]);
    questionTypeMix[questionType(row.marks)] += 1;
  }

  const totals = [...byPaper.values()].map((marks) => marks.reduce((sum, m) => sum + m, 0));
  const counts = [...byPaper.values()].map((marks) => marks.length);

  return {
    paperNumber,
    observedPaperCount: byPaper.size,
    typicalTotalMarks: median(totals, 50),
    typicalQuestionCount: median(counts, 8),
    /** Share of the sampled papers' questions whose marks are known, 0-1. */
    markCoverage,
    questionTypeMix,
  };
}

/**
 * A predicted paper for a subject the bank holds and the legacy table does not.
 *
 * No model runs here, and that is the point rather than a shortcut: with no
 * question text there is nothing for one to read, so a call would spend money
 * and up to a minute of budget to reorder a list it cannot see. It is also the
 * last path in mock-exam generation that could time out and strand a paper.
 *
 * What the student gets is honest: a paper matching the observed mark total,
 * length and question-size spread of that subject's real papers of that
 * number, drawn from questions that have a published mark scheme.
 */
async function createBankPredictedPaper(
  input: PredictedPaperOptions,
  subjectName: string,
  subjectCode: string,
  subjectCodes: string[],
): Promise<PredictedPaperResult | null> {
  // Null rather than a throw: the caller can still fall back to a thin legacy
  // corpus, and an error here would deny a paper it could actually build.
  const blueprint = await buildBankBlueprint(subjectCodes, input.paperNumber);
  if (!blueprint) return null;

  const targetMarks = input.totalMarks ?? blueprint.typicalTotalMarks;
  const targetCount = Math.max(
    1,
    Math.min(
      MAX_KEYED_EXAM_ITEMS,
      input.questionCount ?? Math.max(4, blueprint.typicalQuestionCount),
    ),
  );

  const selected = await selectBankQuestions({
    subjectCodes,
    targetMarks,
    maxItems: targetCount,
    // Only questions a model has to mark constrain one submission.
    maxUnkeyedItems: MAX_EXAM_ITEMS,
    paperNumber: blueprint.paperNumber,
  });

  if (selected.length === 0) return null;

  const computedMarks = totalMarksOf(selected);
  const targetDuration = input.durationMinutes ?? Math.max(30, Math.round(computedMarks * 1.5));
  const paperLabel = blueprint.paperNumber ? `Paper ${blueprint.paperNumber}` : 'past papers';
  // Say what was measured, not what the real paper is worth. Where the mark
  // extraction has not covered a whole paper the measured total is lower than
  // the printed one -- Additional Mathematics Paper 2 measures 62 against a
  // real 80 -- and quietly presenting that as the paper's length would be a
  // wrong number stated confidently.
  const blueprintSummary =
    `Modelled on ${blueprint.observedPaperCount} real ${subjectName} ${paperLabel} papers. ` +
    (blueprint.markCoverage < 0.9
      ? `Marks are known for ${Math.round(blueprint.markCoverage * 100)}% of their questions, ` +
        `which average ${blueprint.typicalTotalMarks} marks over ${blueprint.typicalQuestionCount} ` +
        'questions, so a real sitting is longer than this.'
      : `Those average ${blueprint.typicalTotalMarks} marks over ` +
        `${blueprint.typicalQuestionCount} questions, and this paper matches that shape.`);

  const exam = await prisma.mockExam.create({
    data: {
      userId: input.userId,
      title: input.title?.trim() || `${subjectName} Predicted Paper`,
      description:
        `Predicted practice paper: ${selected.length} questions, ${computedMarks} marks, ` +
        `matching the structure of real ${subjectName} ${paperLabel} papers.`,
      subjectCode,
      durationMinutes: targetDuration,
      totalMarks: computedMarks,
      topics: unique(input.topics ?? []),
      difficulty: `predicted:${input.difficulty ?? 'mixed'}`,
      status: 'generated',
      items: {
        create: selected.map((question, order) => ({
          bankQuestionId: question.id,
          sectionTitle: 'Section A',
          order,
        })),
      },
    },
  });

  return {
    exam: {
      id: exam.id,
      title: exam.title,
      subjectCode,
      questionCount: selected.length,
      totalMarks: computedMarks,
    },
    prediction: {
      // Structure is observed; the question mix is a draw. Claiming more than
      // "medium" for a paper assembled without reading a single question would
      // be dressing a random sample up as insight.
      confidence: 'medium',
      blueprintSummary,
      syllabusCoverage: [],
      markSchemeGuide: [],
      observedPaperCount: blueprint.observedPaperCount,
      paperNumber: blueprint.paperNumber,
      questionTypeMix: blueprint.questionTypeMix,
    },
  };
}

export async function createPredictedPaper(input: PredictedPaperOptions): Promise<PredictedPaperResult> {
  const subject = await prisma.subject.findUnique({ where: { code: input.subjectCode } });
  if (!subject) throw new Error(`Unknown subject code: ${input.subjectCode}`);

  const topics = unique(input.topics ?? []);

  // Which corpus can serve this subject decides which kind of paper it gets.
  //
  // Deciding before the blueprint is deliberate: `buildBlueprint` throws when
  // the legacy table has no structure for the subject, and for every CAIE
  // subject it does not. That throw is what students saw as a failed
  // generation while the bank held thousands of their questions.
  const path = (await predictionPathsFor([subject.code])).get(subject.code);

  if (path === 'assembled') {
    const bankCodes = toBankSubjectCodes([subject.code]);
    const assembled = await createBankPredictedPaper(
      input,
      subject.name,
      subject.code,
      bankCodes,
    );
    if (assembled) return assembled;
    // The bank looked servable and then could not fill this particular paper.
    // Fall through rather than refuse: the legacy corpus may still manage one.
  }

  const blueprint = await buildBlueprint(subject.id, input.paperNumber);
  const candidates = await loadCandidateQuestions({
    subjectId: subject.id,
    paperNumber: blueprint.paperNumber,
    topics,
  });
  if (candidates.length === 0) throw new Error('No eligible questions are available for this subject.');

  const markschemes = await Promise.all(candidates.map((question) => findMatchingMarkscheme(question)));
  const targetMarks = input.totalMarks ?? blueprint.typicalTotalMarks;
  // Clamped to what one submission can grade inside a single function
  // invocation — see lib/mock-exam-limits.ts. A predicted paper larger than
  // this generates fine and is then impossible to submit.
  const targetCount = Math.max(
    1,
    Math.min(
      MAX_EXAM_ITEMS,
      input.questionCount ?? Math.max(4, Math.min(20, blueprint.typicalQuestionCount))
    )
  );
  const targetDuration = input.durationMinutes ?? Math.max(30, Math.round(targetMarks * 1.5));

  const catalogue = candidates.map((question, index) => ({
    id: question.id,
    year: question.paper.year,
    session: question.paper.session,
    paperNumber: question.paper.paperNumber,
    variant: question.paper.variant,
    number: question.number,
    part: question.part,
    subPart: question.subPart,
    topic: question.topic || 'General',
    marks: question.marks,
    questionType: questionType(question.marks),
    preview: plainText(question.content, 240),
    markschemePreview: plainText(markschemes[index]?.content ?? '', 220),
  }));

  const plan = await chatJSON<PredictedPaperAIPlan>(
    [
      { role: 'system', content: PREDICTED_PAPER_PROMPT },
      {
        role: 'user',
        content: `Create a predicted practice paper.

Subject: ${subject.name} (${subject.code})
Observed paper number: ${blueprint.paperNumber ?? 'mixed'}
Observed paper count: ${blueprint.observedPaperCount}
Target marks: ${targetMarks}
Target duration: ${targetDuration} minutes
Target question count: ${targetCount}
Difficulty: ${input.difficulty ?? 'mixed'}
Requested focus topics: ${topics.length ? topics.join(', ') : 'none'}
Frequent topics from historical bank: ${blueprint.frequentTopics.join(', ') || 'General'}
Observed question-type mix: ${JSON.stringify(blueprint.questionTypeMix)}

Candidate questions:
${JSON.stringify(catalogue)}`,
      },
    ],
    { credential: input.credential, temperature: 0.35, maxTokens: 3000 }
  );

  const candidateIds = new Set(candidates.map((question) => question.id));
  const usedIds = new Set<number>();
  const flatItems: Array<{ questionId: number; sectionTitle: string; order: number }> = [];
  for (const section of plan.sections ?? []) {
    for (const questionId of section.questionIds ?? []) {
      // The count in the prompt is a hint; the model often exceeds it.
      if (flatItems.length >= MAX_EXAM_ITEMS) break;
      if (!candidateIds.has(questionId) || usedIds.has(questionId)) continue;
      usedIds.add(questionId);
      flatItems.push({
        questionId,
        sectionTitle: section.title || 'Predicted section',
        order: flatItems.length,
      });
    }
    if (flatItems.length >= MAX_EXAM_ITEMS) break;
  }

  if (flatItems.length === 0) {
    for (const question of candidates.slice(0, targetCount)) {
      flatItems.push({
        questionId: question.id,
        sectionTitle: question.topic && question.topic !== 'General' ? question.topic : 'Predicted section',
        order: flatItems.length,
      });
    }
  }

  const selected = candidates.filter((question) => usedIds.has(question.id) || flatItems.some((item) => item.questionId === question.id));
  const computedMarks = selected.reduce((sum, question) => sum + question.marks, 0);
  const selectedTopics = unique([...topics, ...selected.map((question) => question.topic), ...(plan.syllabusCoverage ?? [])], 14);
  const title = input.title?.trim() || plan.title || `${subject.name} Predicted Paper`;
  const descriptionParts = [
    'Predicted practice paper assembled from the question database and observed historical paper structure.',
    plan.description,
    plan.blueprintSummary ? `Blueprint: ${plan.blueprintSummary}` : null,
    'Mark schemes are attached from the selected past-paper questions where available.',
  ].filter(Boolean);

  const exam = await prisma.mockExam.create({
    data: {
      userId: input.userId,
      title,
      description: descriptionParts.join(' '),
      subjectCode: subject.code,
      durationMinutes: plan.durationMinutes || targetDuration,
      totalMarks: computedMarks || plan.totalMarks || targetMarks,
      topics: selectedTopics,
      difficulty: `predicted:${input.difficulty ?? 'mixed'}`,
      items: {
        create: flatItems.map((item) => ({
          questionId: item.questionId,
          sectionTitle: item.sectionTitle,
          order: item.order,
        })),
      },
    },
  });

  return {
    exam: {
      id: exam.id,
      title: exam.title,
      subjectCode: subject.code,
      questionCount: flatItems.length,
      totalMarks: computedMarks || plan.totalMarks || targetMarks,
    },
    prediction: {
      confidence: plan.confidence ?? 'medium',
      blueprintSummary: plan.blueprintSummary || `Based on ${blueprint.observedPaperCount} observed papers.`,
      syllabusCoverage: unique(plan.syllabusCoverage ?? selectedTopics, 12),
      markSchemeGuide: (plan.markSchemeGuide ?? []).filter((guide) => candidateIds.has(guide.questionId)).slice(0, flatItems.length),
      observedPaperCount: blueprint.observedPaperCount,
      paperNumber: blueprint.paperNumber,
      questionTypeMix: blueprint.questionTypeMix,
    },
  };
}
