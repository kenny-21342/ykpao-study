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
 */
export function decideGradingMode(params: {
  requiresDiagram: boolean;
  answerImageUrl: string | null;
}): GradingMode {
  return params.requiresDiagram || Boolean(params.answerImageUrl) ? 'vision' : 'text';
}

/**
 * Grade an image answer directly, returning the same partial-GradeResult
 * shape the text grader produces so callers don't need to branch on which
 * path actually graded the attempt. Returns {} (ungraded) rather than
 * throwing, matching the text path's failure behavior -- an attempt is
 * still worth persisting even when grading itself fails.
 */
export async function runVisionGrading(params: {
  imageUrl: string;
  questionText: string;
  markscheme?: string | null;
  totalMarks?: number | null;
  credential: VisionCredential;
}): Promise<Partial<GradeResult>> {
  const result = await gradeWithVision(params);
  return result ?? {};
}
