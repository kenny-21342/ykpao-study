import type { GradeResult } from '../types/ai.ts';

/** Clamp the model's mark to the question and derive the stored fields. */
export function bankGradeFields(grade: Partial<GradeResult>, totalMarks: number | null) {
  const max = totalMarks && totalMarks > 0 ? totalMarks : Number(grade.maxScore) > 0 ? Math.round(Number(grade.maxScore)) : 1;
  const awarded = Math.max(0, Math.min(max, Math.round(Number(grade.score) || 0)));
  return {
    awardedMarks: awarded,
    outOfMarks: max,
    score: awarded / max,
    isCorrect: typeof grade.isCorrect === 'boolean' ? grade.isCorrect && awarded === max : awarded === max,
  };
}
