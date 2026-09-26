/**
 * What the student is looking at, and how it is described to the AI tutor.
 *
 * React-free on purpose. The serialiser is the only thing standing between the
 * tutor and a confidently wrong answer about the wrong question, and it holds
 * two rules that are easy to lose in a refactor: a question with no transcript
 * must be declared unreadable rather than guessed at, and a paper that is
 * still in progress must carry the instruction not to answer it. Both are
 * tested in `tests/screen-context.test.ts`, which cannot import a `'use
 * client'` component that calls hooks.
 */

export type ScreenContext = {
  // Which section of the app is active
  tab: string;
  // Human-readable description of what the student is viewing
  description: string;
  // Structured data depending on context (flexible)
  data: {
    // Practice
    questionId?: number;
    questionCode?: string;       // e.g. "0610-S24-P42-Q1"
    questionTopic?: string;      // e.g. "B5.1 Plant nutrition"
    questionSubject?: string;    // e.g. "Biology"
    questionText?: string;       // first 500 chars of the question content
    questionMarks?: number;

    // Notes
    noteId?: string;
    noteTitle?: string;
    noteContent?: string;
    noteSelection?: string;

    // Bank practice -- the crop-first corpus, which is most of what students
    // actually open. `bankQuestionId` is deliberately the id and not the text:
    // the client never receives `bodyMd` (`BankQuestionView` carries only
    // `hasText`), so the server resolves the wording itself in
    // `/api/ai/rag-chat`. That also keeps a 6,000-character prompt field from
    // being spent on something the database already holds.
    bankQuestionId?: number;
    bankPaperReference?: string;   // e.g. "0625 2024 June Paper 4 Variant 1"
    bankCommandTerms?: string[];   // e.g. ["calculate", "explain"]
    bankHasText?: boolean;         // false => the tutor cannot read this one

    // Practice / exam
    practiceMode?: 'browse' | 'practice';
    recentAttemptScore?: number | null;

    // Mock exams
    examTitle?: string;
    examItemPosition?: string;     // e.g. "question 3 of 12"
    examItemMarks?: number | null;
    examSubmitted?: boolean;

    // Study coach
    studyView?: string;            // today | plan | mistakes | review | mastery | search

    // Discussions
    threadTitle?: string;
    threadSubject?: string;

    // Resource library
    resourceFolderPath?: string;

    // Weakness heatmap
    weakestTopic?: string;

    // General
    courseId?: string;           // enrolled Course.id for server-side validation
    subjectCode?: string;        // e.g. "0610" — used for RAG filtering
  };
  // Timestamp of last update (so the AI knows how fresh the context is)
  updatedAt: number;
};

export const DEFAULT_SCREEN_CONTEXT: ScreenContext = {
  tab: 'dashboard',
  description: 'Viewing the dashboard',
  data: {},
  updatedAt: 0,
};

/** Serialise the context into the block the tutor prompt embeds. */
export function serializeScreenContext(context: ScreenContext): string {

  const d = context.data;
  const parts: string[] = [];

  parts.push(`Section: ${context.description}`);

  if (d.questionCode) {
    parts.push(`Viewing question: ${d.questionCode} (${d.questionSubject ?? 'Unknown subject'})`);
    if (d.questionTopic) parts.push(`Topic: ${d.questionTopic}`);
    if (d.questionMarks) parts.push(`Marks: ${d.questionMarks}`);
    if (d.questionText) parts.push(`Question text: ${d.questionText}`);
    if (d.practiceMode === 'practice') parts.push(`The student is in practice mode and writing an answer.`);
  }

  if (d.bankPaperReference) {
    parts.push(`Viewing past-paper question: ${d.bankPaperReference}`);
    if (d.bankCommandTerms?.length) {
      parts.push(`Command terms: ${d.bankCommandTerms.join(', ')}`);
    }
    // Said plainly, because the alternative is a tutor that invents a
    // question it cannot see. 65,572 of 66,756 published questions are
    // transcribed; the rest exist only as image crops.
    if (d.bankHasText === false) {
      parts.push('This question has not been transcribed, so its wording is '
        + 'not available to you. Ask the student to type or describe it '
        + 'rather than guessing what it says.');
    }
  }

  if (d.examTitle) {
    parts.push(`Sitting mock exam: "${d.examTitle}"`
      + (d.examItemPosition ? ` — ${d.examItemPosition}` : ''));
    if (d.examItemMarks) parts.push(`This question is worth ${d.examItemMarks} marks.`);
    if (d.examSubmitted) {
      parts.push('The exam is already submitted, so they are reviewing it.');
    } else {
      // The one case where the honest answer is to refuse.
      parts.push('The exam is in progress and not yet submitted. Do not give '
        + 'the answer; help them with method and understanding only.');
    }
  }

  if (d.studyView) parts.push(`Study view: ${d.studyView}`);

  if (d.threadTitle) {
    parts.push(`Reading discussion thread: "${d.threadTitle}"`
      + (d.threadSubject ? ` (${d.threadSubject})` : ''));
  }

  if (d.resourceFolderPath) parts.push(`Browsing resources in: ${d.resourceFolderPath}`);

  if (d.noteTitle) {
    parts.push(`Viewing note: "${d.noteTitle}"`);
    if (d.noteSelection) parts.push(`Selected note text: ${d.noteSelection}`);
    if (d.noteContent) parts.push(`Note content: ${d.noteContent}`);
  }

  if (d.weakestTopic) {
    parts.push(`The student's weakest topic is: ${d.weakestTopic}`);
  }

  if (d.subjectCode) {
    parts.push(`Subject: ${d.subjectCode}`);
  }

  return parts.join('\n');

}
