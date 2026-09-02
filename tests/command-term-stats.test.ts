import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_ATTEMPTS_FOR_SIGNAL,
  summariseCommandTerms,
  weakestCommandTerm,
} from '../lib/command-term-stats.ts';

function attempt(
  terms: string[],
  isCorrect: boolean,
  score: number | null = null,
  totalMarks: number | null = null,
) {
  return { terms, isCorrect, score, totalMarks };
}

test('accuracy falls back to right/wrong when nothing carries marks', () => {
  const [stat] = summariseCommandTerms([
    attempt(['explain'], true),
    attempt(['explain'], false),
    attempt(['explain'], false),
    attempt(['explain'], false),
  ]);
  assert.equal(stat.slug, 'explain');
  assert.equal(stat.attempts, 4);
  assert.equal(stat.correct, 1);
  assert.equal(stat.accuracy, 25);
  assert.equal(stat.markBased, false);
});

test('marks are used where the questions carry them', () => {
  // 4/6 and 3/6 is 58%, which is the number that matters on an extended
  // response -- "wrong" twice would have said 0%.
  const [stat] = summariseCommandTerms([
    attempt(['evaluate'], false, 4, 6),
    attempt(['evaluate'], false, 3, 6),
  ]);
  assert.equal(stat.accuracy, 58);
  assert.equal(stat.markBased, true);
});

test('a mostly-unmarked mix reports right/wrong rather than a blended figure', () => {
  const stats = summariseCommandTerms([
    attempt(['describe'], true, 5, 5),
    attempt(['describe'], false),
    attempt(['describe'], false),
    attempt(['describe'], false),
  ]);
  assert.equal(stats[0].markBased, false);
  assert.equal(stats[0].accuracy, 25);
});

test('a question tagged with several terms counts once against each', () => {
  const stats = summariseCommandTerms([attempt(['state', 'explain'], false)]);
  assert.deepEqual(stats.map((s) => s.slug).sort(), ['explain', 'state']);
  assert.equal(stats[0].attempts, 1);
});

test('a duplicated term on one question is still one attempt', () => {
  const [stat] = summariseCommandTerms([attempt(['state', 'state'], true)]);
  assert.equal(stat.attempts, 1);
});

test('unknown slugs are ignored rather than reported as a blank row', () => {
  assert.deepEqual(summariseCommandTerms([attempt(['ponder'], false)]), []);
});

test('results are weakest first, with more evidence breaking ties', () => {
  const stats = summariseCommandTerms([
    attempt(['state'], true),
    attempt(['state'], true),
    attempt(['explain'], false),
    attempt(['discuss'], false),
    attempt(['discuss'], false),
  ]);
  assert.deepEqual(stats.map((s) => s.slug), ['discuss', 'explain', 'state']);
});

test('a null score with a total does not drag accuracy to zero', () => {
  // An unmarked attempt should be invisible to the marks path, not a 0/6.
  const [stat] = summariseCommandTerms([
    attempt(['evaluate'], true, null, 6),
    attempt(['evaluate'], true, 6, 6),
  ]);
  assert.equal(stat.accuracy, 100);
});

test('the weakest term needs enough attempts behind it', () => {
  const thin = summariseCommandTerms([attempt(['discuss'], false)]);
  assert.equal(weakestCommandTerm(thin), null);

  const solid = summariseCommandTerms(
    Array.from({ length: MIN_ATTEMPTS_FOR_SIGNAL }, () => attempt(['discuss'], false)),
  );
  assert.equal(weakestCommandTerm(solid)?.slug, 'discuss');
});

test('a term the student is fine at is not reported as a weakness', () => {
  const stats = summariseCommandTerms(
    Array.from({ length: 10 }, (_, i) => attempt(['state'], i < 8)),
  );
  assert.equal(stats[0].accuracy, 80);
  assert.equal(weakestCommandTerm(stats), null);
});

test('no attempts yields no rows and no weakness', () => {
  assert.deepEqual(summariseCommandTerms([]), []);
  assert.equal(weakestCommandTerm([]), null);
});

test('an unmarked attempt is not counted as a wrong one', () => {
  const stats = summariseCommandTerms([
    { terms: ['explain'], isCorrect: null, score: null, totalMarks: 6 },
    attempt(['explain'], true),
  ]);
  assert.equal(stats[0].attempts, 1);
  assert.equal(stats[0].accuracy, 100);
});

test('an unmarked attempt that still carries marks does count', () => {
  const [stat] = summariseCommandTerms([
    { terms: ['evaluate'], isCorrect: null, score: 3, totalMarks: 6 },
  ]);
  assert.equal(stat.attempts, 1);
  assert.equal(stat.accuracy, 50);
  assert.equal(stat.markBased, true);
});
