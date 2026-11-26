import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Subject-specific examiner guidance for the AI grader.
 *
 * The grader prompt is subject-blind: it asks for "a concise model answer" to
 * whatever it is shown. For an IB Economics essay that produced a bullet
 * summary of the mark scheme -- accurate, and nothing like the response that
 * reaches the top markband, which IB marks on defined terms, explained and
 * applied diagrams, developed real-world examples and a reasoned judgement.
 *
 * Two layers, both optional:
 *
 * 1. Rules, written here in our own words, distilled from IB assessed student
 *    work and the examiner comments on it (Paper 1 essays, Paper 2 data
 *    response, Paper 3 policy/quantitative) plus a teacher's essay structure.
 *    These live in the repository.
 *
 * 2. Exemplar notes: a teacher's marking notes for ~30 common 15-mark
 *    questions, built by scripts/build-subject-exemplars.py. They are someone
 *    else's teaching material and this repository is public, so they are NOT
 *    committed. They are read from SUBJECT_EXEMPLARS_DIR (default
 *    `data/private/`, gitignored) and simply skipped when the file is absent.
 */

export type GuidanceInput = {
  /** Course or subject identifier: `ib-economics`, a bank subject code, or a display name. */
  subject: string | null | undefined;
  /** Total marks for the item being graded. */
  marks: number | null | undefined;
  /** The question text, used to pick the nearest exemplar. */
  questionText: string;
};

/** CAIE syllabus codes for economics; these follow a different scheme. */
const CAIE_ECONOMICS = /\b(9708|0455|2281|0987)\b/;

export function isIbEconomics(subject: string | null | undefined): boolean {
  if (!subject) return false;
  return /econ/i.test(subject) && !CAIE_ECONOMICS.test(subject);
}

/**
 * An item worth 10 or more marks is extended response: a Paper 1 essay
 * (10 + 15), a Paper 2 part (g) or a Paper 3 policy recommendation.
 */
export function isExtendedResponse(marks: number | null | undefined): boolean {
  return (marks ?? 0) >= 10;
}

const IB_ECONOMICS_RULES = `IB ECONOMICS MARKING GUIDANCE (apply on top of the markscheme)

Extended response (10- and 15-mark parts) is marked by markbands, not points. The top band needs ALL of:
- Relevant economic terms defined precisely at the start and used accurately throughout.
- Relevant theory fully explained as a chain of cause and effect, not asserted.
- Diagrams that are relevant, accurate, fully labelled (axes named with the real market or currency, e.g. "Price of JOD in USD" / "Quantity of JOD", curves, equilibria, shifts with arrows), and explained in the text with reference to their labels. A diagram drawn but not explained or not applied to the case earns little.
- For 15-mark parts: real-world examples that are specific (named country, market, policy, year or figure) and fully developed -- woven through the argument, not a one-line mention.
- For 15-mark parts: effective, balanced synthesis/evaluation -- consider short run vs long run, different stakeholders, assumptions, magnitude, alternatives and priorities, then reach a justified judgement that answers the command term. A one-sided answer cannot reach the top band however detailed.
- 10-mark parts are analysis only: definitions, theory, a diagram; evaluation is not required.
- A typed answer cannot contain a drawing. When the student describes a diagram precisely (axes, curves, the shift, the new equilibrium) and explains it, credit it as a diagram; only penalise a diagram that is missing, wrong, or never explained.
A reliable 15-mark "evaluate a policy" structure: define the policy and the objective; show with a diagram how the policy is meant to work; develop two or three advantages, each with a real case; develop two or three limitations, each with a real case; conclude with a weighed judgement (it depends on X, because Y).

Short-answer and data-response parts (Papers 2 and 3):
- Calculations: working must be shown; a correct bare answer earns only partial credit. Include units/currency and scale (e.g. "$4.2 million", "NZ$"). Give money to two decimal places unless told otherwise.
- Own figure rule: an error carried forward from an earlier part is not penalised again if the later method is correct.
- "Calculate the decrease" does not need a minus sign; "calculate the change" does.
- "Using information from the text/data" requires explicit use of that data in the answer.
- When asked to comment on or criticise a claim drawn from data, a correlation is not causation and saying so earns the mark.
- Precision is rewarded: e.g. a tax on food is regressive because low-income households spend a higher proportion of income on it, not because it has "a greater impact".`;

const MODEL_ANSWER_EXTENDED = `MODEL ANSWER FOR THIS ITEM: because this is extended response, "modelAnswer" must be a full exam-standard response that would reach the top markband -- NOT a summary or bullet list of the markscheme. Write it as the student should: continuous prose in paragraphs, opening definitions, the theory as a causal chain, each diagram described in a short labelled block (title, axis labels, curves, the shift and the new equilibrium) followed by prose explaining it, specific real-world examples developed in context, and for 15-mark parts a balanced evaluation ending in a justified conclusion. Aim for roughly 300-400 words per 10-mark part and 550-750 words per 15-mark part. Answer every part the question has, each under its own label.`;

type Exemplar = { question: string; notes: string; source?: string };

let exemplarCache: Exemplar[] | null = null;

function loadExemplars(): Exemplar[] {
  if (exemplarCache) return exemplarCache;
  const dir = process.env.SUBJECT_EXEMPLARS_DIR || path.join(process.cwd(), 'data', 'private');
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, 'ib-economics-exemplars.json'), 'utf8'));
    exemplarCache = Array.isArray(raw)
      ? raw.filter((e): e is Exemplar => typeof e?.question === 'string' && typeof e?.notes === 'string')
      : [];
  } catch {
    // Absent in a fresh checkout and in CI; the rules alone still apply.
    exemplarCache = [];
  }
  return exemplarCache;
}

/** Test hook. */
export function setExemplarsForTest(items: Exemplar[] | null): void {
  exemplarCache = items;
}

const STOP = new Set(
  ('the a an and or of to in on for with by as is are be that this which using real world life examples example ' +
    'discuss evaluate explain view whether extent marks mark may might can its their from how why what more most ' +
    'than not into between'
  ).split(' '),
);

function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z\s-]/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/(ies)$/, 'y').replace(/(?<!s)s$/, ''))
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

/**
 * The teacher exemplar nearest the question, or null when nothing is close.
 *
 * Scored on the exemplar's question (weighted) plus the opening of its notes,
 * so "effectiveness of monetary policy in reducing inflation" finds notes on
 * policies against inflation even though the wording differs.
 */
export function nearestExemplar(questionText: string): Exemplar | null {
  const items = loadExemplars();
  if (!items.length) return null;
  const q = terms(questionText);
  if (!q.size) return null;
  let best: { item: Exemplar; score: number } | null = null;
  for (const item of items) {
    const head = terms(item.question);
    const body = terms(item.notes.slice(0, 1500));
    let score = 0;
    for (const t of q) {
      if (head.has(t)) score += 3;
      else if (body.has(t)) score += 1;
    }
    if (!best || score > best.score) best = { item, score };
  }
  return best && best.score >= 6 ? best.item : null;
}

function clipWords(text: string, max: number): string {
  const words = text.split(/(\s+)/);
  let count = 0;
  let out = '';
  for (const piece of words) {
    if (/\S/.test(piece)) count += 1;
    if (count > max) return `${out.trimEnd()} ...`;
    out += piece;
  }
  return out;
}

/**
 * Extra system-prompt text for grading this item, or '' when the subject has
 * no guidance. Safe to append to any grader system prompt.
 */
export function graderGuidance(input: GuidanceInput): string {
  if (!isIbEconomics(input.subject)) return '';
  const blocks = [IB_ECONOMICS_RULES];
  if (isExtendedResponse(input.marks)) {
    blocks.push(MODEL_ANSWER_EXTENDED);
    const exemplar = nearestExemplar(input.questionText);
    if (exemplar) {
      blocks.push(
        `TEACHER'S REVISION NOTES FOR A SIMILAR QUESTION ("${exemplar.question.trim()}").
These are a teacher's content notes, not the markscheme: use them for relevant theory, diagrams ("[diagram]" marks where one belongs) and real-world examples where they fit THIS question. Never mark the student against them, and do not copy them -- the model answer must still answer the question actually asked.
"""
${clipWords(exemplar.notes, 750)}
"""`,
      );
    }
  }
  return `\n\n${blocks.join('\n\n')}`;
}

/**
 * Output budget for the grader.
 *
 * Not only an economics concern. The text model reasons before it answers and
 * those tokens count against max_tokens: grading a ~600-word essay at the old
 * flat 1200 spent all 1200 on reasoning and returned nothing, every time
 * (finish_reason=length, reasoning_tokens=1200), so any extended response in
 * any subject came back "empty response". Extended items get room to think
 * and to write; IB Economics more again, for the full-length model answer.
 */
/**
 * Whether to switch the model's reasoning off for this grade.
 *
 * An IB Economics essay grade writes strengths, weaknesses, an explanation and
 * a 600-800 word model answer. With reasoning on, those reasoning tokens share
 * the same max_tokens, and in testing the reply was cut off mid-answer often
 * enough to lose the grade even at 6000. Without reasoning the
 * output fits, the call takes roughly half the time, and the grades in the
 * before/after comparison were no less consistent.
 */
export function graderNoThinking(input: Pick<GuidanceInput, 'subject' | 'marks'>): boolean {
  return isIbEconomics(input.subject) && isExtendedResponse(input.marks);
}

export function graderMaxTokens(input: Pick<GuidanceInput, 'subject' | 'marks'>, base: number): number {
  if (!isExtendedResponse(input.marks)) return base;
  return Math.max(base, isIbEconomics(input.subject) ? 6000 : 4000);
}
