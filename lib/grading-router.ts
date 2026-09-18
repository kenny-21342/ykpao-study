import { gradeWithVision, type ProviderUsage } from './vision.ts';
import type { VisionCredential } from './ai-credentials';
import type { GradeResult } from '@/types/ai';
import { isRetrievableText } from './rag-file-text.ts';

export type GradingMode = 'text' | 'vision';

/**
 * A diagram-flagged question (PastPaperQuestion.hasDiagram /
 * BankQuestion.requiresDiagram) always routes to vision, since OCR has
 * nothing useful to transcribe from a graph or construction. An
 * image answer on a question that isn't flagged also routes to vision --
 * a student may attach a drawing to a question the catalogue didn't
 * anticipate. Everything else keeps the OCR-then-text path.
 *
 * `hasQuestionText` overrides all of that. The crop-first bank stores the
 * question as image strips and leaves `bodyMd` empty for the whole crop-only
 * corpus, and `lib/bank-questions.ts` states the rule those rows imply:
 * anything that *reasons* over a question rather than displaying it needs the
 * transcript and is gated off without it. Vision grading was the one path that
 * ignored the rule -- it sends the student's answer image with an empty
 * `Question:` heading, and the marker duly reports it "cannot determine what
 * the student was supposed to draw" and returns zero. A confident zero on an
 * unreadable question is worse than no mark at all, so route back to text and
 * let the caller's existing untranscribed branch record the attempt honestly
 * as ungraded.
 */
/**
 * Whether a question body carries enough *prose* to reason over.
 *
 * `Boolean(body.trim())` is not that test. A crop failure hands the
 * transcriber a sliver of a page -- 9608 s16 q7 is a 307x93 fragment showing
 * a row of a table and a dot -- and the model honestly answers with a figure
 * reference and nothing else. That body is 15 characters of markup and zero
 * words, but it is truthy, so the gate below opened and vision grading ran
 * against a question it could not read. That is the F16 failure the gate was
 * added to prevent, arriving through a different door.
 *
 * So strip the image references first and apply the same bar the RAG index
 * uses. The two now agree: a body the index refuses to make a document from is
 * a body the grader refuses to reason over, which is the rule
 * `lib/bank-questions.ts` states for the crop-first corpus.
 */
export function hasGradableText(body: string | null | undefined): boolean {
  const prose = (body ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')   // markdown images, incl. asset: refs
    .replace(/<[^>]+>/g, ' ')                  // table and formatting markup
    .replace(/\s+/g, ' ')
    .trim();
  return isRetrievableText(prose);
}

export function decideGradingMode(params: {
  requiresDiagram: boolean;
  answerImageUrl: string | null;
  hasQuestionText: boolean;
}): GradingMode {
  if (!params.hasQuestionText) return 'text';
  return params.requiresDiagram || Boolean(params.answerImageUrl) ? 'vision' : 'text';
}

/**
 * Grade an image answer directly, returning the same partial-GradeResult
 * shape the text grader produces so callers don't need to branch on which
 * path actually graded the attempt. Returns {} (ungraded) rather than
 * throwing, matching the text path's failure behavior -- an attempt is
 * still worth persisting even when grading itself fails.
 *
 * `gradeWithVision` signals failure by returning null, which flattening to {}
 * made indistinguishable from "graded, no marks". The attempt was then written
 * with score 0 and every qualitative field empty, and -- because the caller
 * derived its grading status from whether a markscheme existed rather than
 * from whether grading produced anything -- stamped `official`. A student saw
 * a confident zero with no explanation and no notice. So say which happened.
 *
 * A successful grade also carries the provider's own token counts, so callers
 * book what the call actually cost instead of a flat estimate. `usage` is null
 * when the provider reported none.
 */
export async function runVisionGrading(params: {
  imageUrl: string;
  questionText: string;
  /**
   * What the student typed, if anything. A drawing is usually working shown
   * *alongside* a written answer, and grading the image on its own threw that
   * written answer away -- a correct explanation typed into the answer box
   * scored zero because only the two lines beside it were marked.
   */
  studentText?: string | null;
  markscheme?: string | null;
  totalMarks?: number | null;
  credential: VisionCredential;
  /** Passed straight through to `gradeWithVision`; see its defaults. */
  budgetMs?: number;
  requestTimeoutMs?: number;
}): Promise<
  | { graded: true; grade: Partial<GradeResult>; usage: ProviderUsage | null }
  | { graded: false }
> {
  const result = await gradeWithVision(params);
  return result ? { graded: true, grade: result.grade, usage: result.usage } : { graded: false };
}
