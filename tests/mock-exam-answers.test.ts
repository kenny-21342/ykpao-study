import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasStudentAnswer } from '../lib/mock-exam-answers.ts';

/**
 * Which field proves a student answered.
 *
 * Two plausible fields are traps, and the results header has been wrong via
 * both: `attemptedAt` is stamped on every item at submission (a paper with one
 * answer reported ten attempted), and `answerLetter` is the mark scheme key
 * revealed after submission, not the student's choice (25 of 26 attempted on a
 * paper with a single answer). Only `answer` is the student's own response.
 */

test('typed prose counts as an answer', () => {
  assert.equal(hasStudentAnswer({ answer: 'The testa protects the seed.' }), true);
});

test('a chosen multiple-choice letter counts, because it is stored as the answer', () => {
  assert.equal(hasStudentAnswer({ answer: 'C' }), true);
});

test('an unanswered item does not count', () => {
  assert.equal(hasStudentAnswer({ answer: null }), false);
  assert.equal(hasStudentAnswer({ answer: '' }), false);
});

test('whitespace is not an answer', () => {
  assert.equal(hasStudentAnswer({ answer: '   \n\t ' }), false);
});

test('the mark scheme key does not make an unanswered item count', () => {
  // answerLetter is present on every submitted MCQ. It must not be consulted:
  // the shape below is exactly the 25 items that broke the Attempted count.
  const unansweredMcq = { answer: '', answerLetter: 'B', attemptedAt: new Date().toISOString() };
  assert.equal(hasStudentAnswer(unansweredMcq), false);
});

test('attemptedAt does not make an unanswered item count', () => {
  // Every submitted item carries attemptedAt, answered or not.
  const untouched = { answer: null, attemptedAt: new Date().toISOString() };
  assert.equal(hasStudentAnswer(untouched), false);
});
