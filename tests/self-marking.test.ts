import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_CALIBRATION_SAMPLES,
  SelfMarkError,
  calibrate,
  describeCalibration,
  resolveSelfMark,
} from '../lib/self-marking.ts';

const sixMarker = { totalMarks: 6, hasAnswerKey: false };
const unmarked = { totalMarks: null, hasAnswerKey: false };

test('awarded marks are stored as a fraction of the total', () => {
  const result = resolveSelfMark(sixMarker, { awardedMarks: 4 });
  assert.equal(result?.awardedMarks, 4);
  assert.equal(result?.score, 4 / 6);
  // The bug this feature exists to fix: 4/6 used to be stored as 1 or 0.
  assert.notEqual(result?.score, 1);
});

test('only full marks counts as correct', () => {
  assert.equal(resolveSelfMark(sixMarker, { awardedMarks: 6 })?.isCorrect, true);
  assert.equal(resolveSelfMark(sixMarker, { awardedMarks: 5 })?.isCorrect, false);
});

test('zero marks is a real answer, not a missing one', () => {
  const result = resolveSelfMark(sixMarker, { awardedMarks: 0 });
  assert.equal(result?.score, 0);
  assert.equal(result?.isCorrect, false);
  assert.equal(result?.awardedMarks, 0);
});

test('a question with an answer key cannot be self-marked', () => {
  assert.throws(
    () => resolveSelfMark({ totalMarks: 1, hasAnswerKey: true }, { selfMarkedCorrect: true }),
    SelfMarkError,
  );
});

test('marks beyond the total are refused rather than clamped', () => {
  assert.throws(() => resolveSelfMark(sixMarker, { awardedMarks: 9 }), SelfMarkError);
  assert.throws(() => resolveSelfMark(sixMarker, { awardedMarks: -1 }), SelfMarkError);
  assert.throws(() => resolveSelfMark(sixMarker, { awardedMarks: 2.5 }), SelfMarkError);
});

test('marks cannot be awarded when the corpus never captured a total', () => {
  assert.throws(() => resolveSelfMark(unmarked, { awardedMarks: 3 }), SelfMarkError);
});

test('the binary verdict still works where there is no mark total', () => {
  assert.deepEqual(resolveSelfMark(unmarked, { selfMarkedCorrect: true }), {
    score: 1,
    isCorrect: true,
    awardedMarks: null,
  });
  assert.equal(resolveSelfMark(unmarked, { selfMarkedCorrect: false })?.score, 0);
});

test('an attempt with no verdict at all stays unmarked', () => {
  assert.equal(resolveSelfMark(sixMarker, {}), null);
  assert.equal(resolveSelfMark(sixMarker, { awardedMarks: null }), null);
});

test('calibration needs enough samples before it says anything', () => {
  const one = [{ selfAwarded: 6, authoritative: 3, totalMarks: 6 }];
  assert.equal(calibrate(one), null);

  const enough = Array.from({ length: MIN_CALIBRATION_SAMPLES }, () => ({
    selfAwarded: 5,
    authoritative: 3,
    totalMarks: 6,
  }));
  assert.equal(calibrate(enough)?.bias, 2);
});

test('calibration reports the direction of the gap', () => {
  const generous = Array.from({ length: 6 }, () => ({ selfAwarded: 5, authoritative: 3.5, totalMarks: 6 }));
  assert.equal(calibrate(generous)?.direction, 'generous');

  const harsh = Array.from({ length: 6 }, () => ({ selfAwarded: 2, authoritative: 4, totalMarks: 6 }));
  assert.equal(calibrate(harsh)?.direction, 'harsh');

  const accurate = Array.from({ length: 6 }, () => ({ selfAwarded: 4, authoritative: 4, totalMarks: 6 }));
  assert.equal(calibrate(accurate)?.direction, 'accurate');
});

test('spread separates a consistent bias from noisy marking', () => {
  const consistent = Array.from({ length: 6 }, () => ({ selfAwarded: 5, authoritative: 3, totalMarks: 6 }));
  assert.equal(calibrate(consistent)?.spread, 2);

  // Same mean gap of zero, wildly inconsistent either side of it.
  const noisy = [
    { selfAwarded: 6, authoritative: 2, totalMarks: 6 },
    { selfAwarded: 2, authoritative: 6, totalMarks: 6 },
    { selfAwarded: 6, authoritative: 2, totalMarks: 6 },
    { selfAwarded: 2, authoritative: 6, totalMarks: 6 },
    { selfAwarded: 6, authoritative: 2, totalMarks: 6 },
    { selfAwarded: 2, authoritative: 6, totalMarks: 6 },
  ];
  assert.equal(calibrate(noisy)?.bias, 0);
  assert.equal(calibrate(noisy)?.spread, 4);
});

test('samples with no mark total are dropped, not counted as zero', () => {
  const samples = [
    ...Array.from({ length: 5 }, () => ({ selfAwarded: 4, authoritative: 4, totalMarks: 6 })),
    { selfAwarded: 5, authoritative: 0, totalMarks: 0 },
  ];
  assert.equal(calibrate(samples)?.samples, 5);
  assert.equal(calibrate(samples)?.bias, 0);
});

test('an accurate marker is told nothing rather than something bland', () => {
  const accurate = Array.from({ length: 6 }, () => ({ selfAwarded: 4, authoritative: 4, totalMarks: 6 }));
  assert.equal(describeCalibration(calibrate(accurate)), null);
  assert.equal(describeCalibration(null), null);
});

test('the sentence names marks, direction and how much evidence there is', () => {
  const generous = Array.from({ length: 8 }, () => ({ selfAwarded: 5, authoritative: 3.6, totalMarks: 6 }));
  const sentence = describeCalibration(calibrate(generous));
  assert.match(sentence!, /1\.4 more marks/);
  assert.match(sentence!, /8 marked questions/);
});
