import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aiVerdictFrom, bankGradeFields } from '../lib/bank-grade-fields.ts';

test('AI marks are clamped to the question and stored as marks and a fraction', () => {
  assert.deepEqual(bankGradeFields({ score: 4, maxScore: 6, isCorrect: false }, 6), {
    awardedMarks: 4, outOfMarks: 6, score: 4 / 6, isCorrect: false,
  });
  // A model that over-awards is held to the paper's total.
  assert.equal(bankGradeFields({ score: 9, maxScore: 9 }, 6).awardedMarks, 6);
  // isCorrect means full marks, whatever the model claims.
  assert.equal(bankGradeFields({ score: 5, isCorrect: true }, 6).isCorrect, false);
  assert.equal(bankGradeFields({ score: 6 }, 6).isCorrect, true);
});

test('with no total on the question, the model\'s own maximum is used', () => {
  assert.deepEqual(bankGradeFields({ score: 2, maxScore: 3 }, null), {
    awardedMarks: 2, outOfMarks: 3, score: 2 / 3, isCorrect: false,
  });
  assert.equal(bankGradeFields({}, null).outOfMarks, 1);
});

test('aiVerdictFrom keeps only usable feedback for storage', () => {
  const verdict = aiVerdictFrom({
    official: true,
    mode: 'vision',
    grade: { explanation: '  ', strengths: ['Correct method', 3, ''], weaknesses: 'not a list', modelAnswer: 'x = 2' },
  });
  assert.deepEqual(verdict, {
    graded: true,
    official: true,
    mode: 'vision',
    explanation: null,
    strengths: ['Correct method'],
    weaknesses: [],
    modelAnswer: 'x = 2',
  });
});
