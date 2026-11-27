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

/** What the student sees under an AI mark, and what is stored with the attempt. */
export type BankAiVerdict = {
  graded: true;
  official: boolean;
  mode: 'text' | 'vision';
  explanation: string | null;
  strengths: string[];
  weaknesses: string[];
  modelAnswer: string | null;
};

export function aiVerdictFrom(result: {
  official: boolean;
  mode: 'text' | 'vision';
  grade: { explanation?: unknown; strengths?: unknown; weaknesses?: unknown; modelAnswer?: unknown };
}): BankAiVerdict {
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
  return {
    graded: true,
    official: result.official,
    mode: result.mode,
    explanation: text(result.grade.explanation),
    strengths: list(result.grade.strengths),
    weaknesses: list(result.grade.weaknesses),
    modelAnswer: text(result.grade.modelAnswer),
  };
}
