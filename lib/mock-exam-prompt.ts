/**
 * Building the question-selection prompt for mock exams.
 *
 * This is the expensive half of generation. The selection call was sending the
 * candidate pool as `JSON.stringify` of 60 objects with 220-character content
 * previews — about 21 KB measured against the largest subject in production —
 * for what is only the task of choosing a dozen ids. Generation was failing
 * most attempts against a 50s budget that cannot rise, because `after()` is
 * bounded by `maxDuration`.
 *
 * Two things shrink it:
 *
 * - **A line per candidate instead of JSON.** The keys were repeated sixty
 *   times and carried no information.
 * - **`topic` instead of a longer preview.** The model is asked to group the
 *   paper into sections by theme, and the bank already stores a topic label
 *   for 5,113 of its 5,115 question rows. A 90-character preview plus a real
 *   topic tells it more about theme than 220 characters of raw question text,
 *   which for a median question (358 characters) was truncating mid-sentence
 *   anyway.
 *
 * Same subject, measured: 20,893 bytes for 60 JSON candidates against 3,890
 * for 30 formatted lines.
 */

/**
 * How many candidates the model chooses from.
 *
 * A paper is capped at MAX_EXAM_ITEMS (12), so 30 is still two and a half
 * times the largest paper anyone can be given — the selection is not
 * meaningfully constrained by this, and the pool is arbitrary either way
 * (it is simply the most recent questions in the subject).
 */
export const MAX_CANDIDATES = 30;

/** Enough to tell what a question is about, given that `topic` says the rest. */
export const CANDIDATE_PREVIEW_CHARS = 90;

export type SelectionCandidate = {
  id: number;
  year: number;
  marks: number;
  topic: string;
  content: string;
};

export type SelectionRequest = {
  subjectName: string;
  subjectCode: string;
  totalMarks: number;
  durationMinutes: number;
  difficulty: string;
  topics: string[];
  targetCount: number;
  candidates: SelectionCandidate[];
};

/**
 * Collapse a question to one line.
 *
 * Whitespace is squashed rather than trimmed: question text carries newlines
 * and indentation from extraction, and a raw newline would break the
 * one-candidate-per-line contract the prompt depends on.
 */
export function previewOf(content: string, maxChars: number = CANDIDATE_PREVIEW_CHARS): string {
  const flattened = content.replace(/\s+/g, ' ').trim();
  return flattened.length <= maxChars ? flattened : `${flattened.slice(0, maxChars).trimEnd()}…`;
}

/** `4812 [6m] 2024 Electricity: A circuit contains a 12V cell…` */
export function formatCandidate(candidate: SelectionCandidate): string {
  const topic = candidate.topic?.trim() || 'General';
  return `${candidate.id} [${candidate.marks}m] ${candidate.year} ${topic}: ${previewOf(candidate.content)}`;
}

export function buildCandidateList(candidates: SelectionCandidate[]): string {
  return candidates.map(formatCandidate).join('\n');
}

export function buildSelectionPrompt(request: SelectionRequest): string {
  const focus = request.topics.length ? `Focus topics: ${request.topics.join(', ')}\n` : '';
  return `Choose questions for a mock exam paper.

Subject: ${request.subjectName} (${request.subjectCode})
Target total marks: ${request.totalMarks}
Duration: ${request.durationMinutes} minutes
Difficulty: ${request.difficulty}
${focus}Number of questions to pick: ${request.targetCount}

Each line below is one question: id [marks] year topic: preview
${buildCandidateList(request.candidates)}

Pick about ${request.targetCount} ids from that list and group them into 1-3 sections by topic. Return JSON only.`;
}
