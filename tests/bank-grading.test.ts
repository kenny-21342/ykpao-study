import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  gradeAgainstKey,
  normalizeOptionLetter,
  optionLettersFor,
} from '../lib/bank-grading.ts';

/**
 * Marking against the stored answer key.
 *
 * This is the path that replaced a model call for every multiple-choice
 * question in the bank, so it has to be right for the shapes students actually
 * type -- not just the bare capital letter the mark scheme stores.
 */

test('a bare letter is accepted in any case or padding', () => {
  for (const raw of ['A', 'a', '  A  ', '\tb\n']) {
    assert.equal(normalizeOptionLetter(raw), raw.trim().toUpperCase());
  }
});

test('the punctuation students actually type is accepted', () => {
  for (const raw of ['A.', 'A)', '(A)', 'A:', 'A,', 'A -', '( a )']) {
    assert.equal(normalizeOptionLetter(raw), 'A', `failed on ${JSON.stringify(raw)}`);
  }
});

test('an option pasted back in full is read as its letter', () => {
  // The daily challenge renders the option table inside the question, so a
  // student copying a row back is a real submission shape.
  assert.equal(normalizeOptionLetter('A Open Closed Closed'), 'A');
  assert.equal(normalizeOptionLetter('D. Open Open Closed'), 'D');
});

test('prose is not mistaken for an option letter', () => {
  // "B" is a letter, but "Because ..." is not a choice of option B.
  assert.equal(normalizeOptionLetter('Because the valves are shut'), null);
  assert.equal(normalizeOptionLetter('x = 6'), null);
  assert.equal(normalizeOptionLetter(''), null);
  assert.equal(normalizeOptionLetter('   '), null);
});

test('letters past E are not options', () => {
  assert.equal(normalizeOptionLetter('Z'), null);
  assert.equal(normalizeOptionLetter('F'), null);
});

test('a correct answer scores, a wrong one names the key', () => {
  const right = gradeAgainstKey('c', 'C');
  assert.deepEqual(right, { isCorrect: true, score: 1, gradedBy: 'key', correctLetter: 'C' });

  const wrong = gradeAgainstKey('A', 'C');
  assert.equal(wrong?.isCorrect, false);
  assert.equal(wrong?.score, 0);
  // The student has to be told what the answer was -- the whole defect this
  // replaces was a graded attempt that revealed nothing.
  assert.equal(wrong?.correctLetter, 'C');
});

test('an unreadable answer to a keyed question is wrong, not unmarkable', () => {
  const grade = gradeAgainstKey('I do not know', 'B');
  assert.equal(grade?.isCorrect, false);
  assert.equal(grade?.correctLetter, 'B');
});

test('no key means no grade, so the caller can fall back to self-marking', () => {
  assert.equal(gradeAgainstKey('A', null), null);
  assert.equal(gradeAgainstKey('A', undefined), null);
  assert.equal(gradeAgainstKey('A', '   '), null);
});

test('options default to four and widen only if the key demands it', () => {
  assert.deepEqual(optionLettersFor('C'), ['A', 'B', 'C', 'D']);
  assert.deepEqual(optionLettersFor(null), ['A', 'B', 'C', 'D']);
  assert.deepEqual(optionLettersFor('E'), ['A', 'B', 'C', 'D', 'E']);
});

/**
 * The mock-exam answer box is a rich-text editor, so a picked option reaches
 * grading as markup rather than a bare letter. Every multiple-choice answer in
 * a submitted mock exam was marked wrong because normalizeOptionLetter reads a
 * leading option letter and found "<". normalizeOptionLetter flattens markup
 * before reading the letter; these assert the shapes that editor actually produces.
 */
test('an option letter is recognised once the editor markup is flattened', () => {
  for (const [html, expected] of [
    ['<p>B</p>', 'B'],
    ['<p>b</p>', 'B'],
    ['<p>C.</p>', 'C'],
    ['<p><strong>D</strong></p>', 'D'],
    ['<p>A and 4</p>', 'A'],
  ] as const) {
    assert.equal(normalizeOptionLetter(html), expected, `failed on ${html}`);
  }
});

test('markup alone is still not an option letter', () => {
  assert.equal(normalizeOptionLetter('<p></p>'), null);
  assert.equal(normalizeOptionLetter('<p>Because the valves are shut</p>'), null);
});

test('a flattened wrong letter is graded wrong, not unmarkable', () => {
  const grade = gradeAgainstKey('<p>A</p>', 'C');
  assert.equal(grade?.isCorrect, false);
  assert.equal(grade?.score, 0);
  assert.equal(grade?.correctLetter, 'C');
});

test('a flattened right letter scores the mark', () => {
  const grade = gradeAgainstKey('<p>B</p>', 'B');
  assert.equal(grade?.isCorrect, true);
  assert.equal(grade?.score, 1);
});
