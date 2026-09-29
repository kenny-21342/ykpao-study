/**
 * Turning a chat answer into a schedule.
 *
 * The app already has a complete proposal pipeline — `createAIActionProposal`
 * builds a draft, `ProposalCard` lets the student edit it, and confirming it
 * writes `StudyTask` rows. What it never had was an entrance from ordinary
 * chat, for two separate reasons, both in `app/api/ai/rag-chat/route.ts`:
 *
 *  1. `proposalAction` only returns `'study-week'` for `intent.name ===
 *     'planning'`, and `intentName` requires one of a short list of literal
 *     words ("plan", "schedule", "roadmap", ...). "What should I study today?"
 *     is a planning question that matches none of them.
 *  2. Even when the intent *is* planning, the proposal is gated on
 *     `needsInput.length === 0`, and `intakeQuestions` returns early for every
 *     non-planning intent — so planning is the only intent that can produce a
 *     plan and the only intent that raises intake questions. A student without
 *     a fully populated `LearningProfile` (note that `targetGrade === 'A'`, the
 *     default, counts as missing) always gets questions, so never gets a draft.
 *
 * So rather than widen either gate — both would change what the assistant says,
 * not just what it offers — this module keys off the *answer*. If the assistant
 * already wrote a plan, the student can convert that plan, whatever the intent
 * classifier made of their question.
 *
 * Everything here is pure: no AI call, no database. That keeps it unit-testable
 * and means the button works even when the shared key is unavailable.
 */

/** A list item that survived parsing, before dates are assigned. */
export type PlanStep = {
  title: string;
  topic: string;
  taskType: 'practice' | 'review' | 'notes' | 'mock-exam' | 'quiz';
  /** Days from today. Taken from a "Day 3"/"Week 2"/weekday heading when the
   *  plan has one, otherwise the item's own position. */
  dayOffset: number;
  durationMinutes: number;
};

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/**
 * `1.` `1)` `-` `*` `•` — and the same markers behind a heading or bold run,
 * because a model very often numbers a plan's steps *as headings*
 * (`#### 1. Master trace tables (20-30 min)`) rather than as a list. Missing
 * that shape was the bug that made this detector return false on the very
 * answer it was written for. `\d{1,2}` keeps it from matching a heading that
 * merely opens with a year, like `### 2024 past papers`.
 */
const LIST_ITEM = /^\s{0,6}(?:#{1,6}\s+)?(?:\*\*)?\s*(?:[-*•+]\s+|\d{1,2}[.)]\s+)(.*\S)\s*$/;

/** `## Day 2`, `**Week 3**`, `Day 4:`, `Monday` — a heading that sets a date. */
const HEADING = /^\s{0,3}(?:#{1,6}\s*)?\**\s*(?:(day|week)\s*(\d{1,2})|(monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;

/** Work a student would actually put in a calendar. */
const ACTIONABLE = /\b(revise|revision|review|recap|practi[cs]e|practise|past\s*paper|question|exercise|drill|flashcard|mock|test|quiz|read|re-?read|watch|note|summar(?:y|ise|ize)|memoris|memoriz|solve|attempt|trace|dry\s*-?\s*run|walk\s*through|worked?\s*example|work\s*through|go\s*through|study|learn|cover|master|check|identify|understand|apply|complete|finish|calculate|sketch|label|derive|explain|consolidate)/i;

/** Anything that implies the answer is laid out over time. */
const TEMPORAL = /\b(day\s*\d|week\s*\d|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|evening|per\s*day|each\s*day|daily|weekly|\d+\s*(?:min|mins|minute|minutes|hour|hours|hr|hrs))\b/i;

const PLAN_VOCAB = /\b(study plan|revision plan|revision schedule|schedule|roadmap|timetable|plan)\b/i;

/** Wording that means the plan spans more than one sitting. */
const MULTI_DAY = /\b(day\s*\d|week\s*\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday|each\s*day|per\s*day|daily|weekly|over\s+the\s+next|tomorrow)\b/i;

const DURATION = /\b(\d{1,3})\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/i;

/** Drop the markdown a model wraps list items in, without eating the words. */
function stripInline(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The verb a step opens with, once any "Monday:" or "Day 2 -" prefix is off.
 * Leading on the verb matters: "Review your mistakes from the last quiz" is a
 * review, not a quiz, and a keyword scan alone reads it as the latter because
 * "quiz" appears in a clause that only names where the mistakes came from.
 */
function leadingVerb(text: string): string {
  const body = text
    .replace(/^(?:day\s*\d{1,2}|week\s*\d{1,2}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening)\b[\s:.\u2013\u2014-]*/i, '')
    .trim();
  return body.split(/[\s:,.]+/, 1)[0]?.toLowerCase() ?? '';
}

function taskTypeFor(text: string): PlanStep['taskType'] {
  const lower = text.toLowerCase();
  const verb = leadingVerb(text);
  if (/^(revise|revisit|review|recap|consolidate|go|master|check|identify|understand|learn|cover|explain)$/.test(verb)) return 'review';
  if (/^(practi[cs]e|practise|solve|attempt|trace|complete|do|work|drill)$/.test(verb)) {
    // "Attempt a timed mock paper" is still a mock even though the verb is a
    // practice verb, so the mock framing overrides it.
    return /\b(mock|full\s*paper|timed\s*(?:paper|exam))\b/.test(lower) ? 'mock-exam' : 'practice';
  }
  if (/^(read|re-?read|reread|watch|write|summaris|summariz|make|take|note)$/.test(verb)) return 'notes';
  if (/^(quiz|test|recall|self-test)$/.test(verb)) return 'quiz';
  // No recognizable leading verb: fall back to a keyword scan. "Past paper" is
  // deliberately practice rather than a mock — practising past paper questions
  // is the common case, and only mock/timed/full-paper wording means a sitting.
  if (/\b(mock|full\s*paper|timed\s*(?:paper|exam))\b/.test(lower)) return 'mock-exam';
  if (/\b(practi[cs]e|practise|past\s*paper|question|exercise|drill|solve|attempt|trace|dry\s*-?\s*run)\b/.test(lower)) return 'practice';
  if (/\b(quiz|flashcard|self\s*-?\s*test|recall)\b/.test(lower)) return 'quiz';
  if (/\b(read|re-?read|watch|note|summar|write\s*up)\b/.test(lower)) return 'notes';
  return 'review';
}

function durationFor(text: string, fallback: number): number {
  const match = text.match(DURATION);
  if (!match) return fallback;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const minutes = /^h/i.test(match[2]) ? value * 60 : value;
  return Math.max(5, Math.min(480, Math.round(minutes)));
}

/**
 * A topic short enough to read in the card's one line. The full sentence stays
 * as the title; this is what the student sees while editing.
 */
function topicFor(title: string): string {
  const head = title.split(/[:—–(]|\s[-]\s/)[0].trim();
  const candidate = head.length >= 4 ? head : title;
  return candidate.replace(/[.,;]+$/, '').slice(0, 160);
}

/** The list items and headings of an answer, in order. */
function readLines(text: string) {
  const steps: { text: string; dayOffset: number | null }[] = [];
  let headingOffset: number | null = null;
  for (const raw of text.split('\n')) {
    const heading = raw.match(HEADING);
    // A heading only counts as one when it is not itself a list item, so
    // "- Monday: revise" stays a task rather than becoming a date marker.
    if (heading && !LIST_ITEM.test(raw)) {
      if (heading[1] && heading[2]) {
        const n = Math.max(1, Number(heading[2]));
        headingOffset = heading[1].toLowerCase() === 'week' ? (n - 1) * 7 : n - 1;
      } else if (heading[3]) {
        headingOffset = WEEKDAYS.indexOf(heading[3].toLowerCase());
      }
      continue;
    }
    const item = raw.match(LIST_ITEM);
    if (item) steps.push({ text: stripInline(item[1]), dayOffset: headingOffset });
  }
  return steps;
}

/**
 * Does this answer read as a study plan?
 *
 * Deliberately conservative: three list items alone is an explanation with
 * bullets, which is most of what the tutor writes. A plan also has work in its
 * items and some sense of time or an explicit request for a plan.
 */
export function looksLikePlan(text: string): boolean {
  if (!text || text.length < 80) return false;
  const steps = readLines(text);
  if (steps.length < 3) return false;
  const actionable = steps.filter((step) => ACTIONABLE.test(step.text)).length;
  if (actionable < 2) return false;
  return TEMPORAL.test(text) || PLAN_VOCAB.test(text);
}

/**
 * The plan's items as schedulable steps. Returns `[]` when the text does not
 * read as a plan, so a caller can treat an empty result as "nothing to offer".
 */
export function parsePlanTasks(text: string, options: { maxTasks?: number } = {}): PlanStep[] {
  if (!looksLikePlan(text)) return [];
  const max = Math.max(1, Math.min(20, options.maxTasks ?? 12));
  const steps = readLines(text).filter((step) => step.text.length >= 8 && ACTIONABLE.test(step.text));
  // A plan with no day or week markers that calls itself today's plan means all
  // of it today — spreading "Today's Study Plan" over four days would schedule
  // something the student never asked for. Without that framing, a bare
  // numbered list reads as one step per day, which is the usual intent.
  const sameDay = !MULTI_DAY.test(text) && /\btoday\b/i.test(text);
  return steps.slice(0, max).map((step, index) => {
    const title = step.text.slice(0, 240);
    return {
      title,
      topic: topicFor(title),
      taskType: taskTypeFor(step.text),
      // A heading's date wins; otherwise the items spread one per day, which is
      // the reading a numbered list invites.
      dayOffset: Math.max(0, Math.min(180, step.dayOffset ?? (sameDay ? 0 : index))),
      durationMinutes: durationFor(step.text, 30),
    };
  });
}
