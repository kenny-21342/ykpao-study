import { gradeWithVision } from './vision';
import type { VisionCredential } from './ai-credentials';
import type { GradeResult } from '@/types/ai';

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
}): Promise<{ graded: true; grade: Partial<GradeResult> } | { graded: false }> {
  const result = await gradeWithVision(params);
  return result ? { graded: true, grade: result } : { graded: false };
}
