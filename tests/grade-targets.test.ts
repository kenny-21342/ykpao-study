import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isGradeOnScale,
  progressToTarget,
  thresholdForGrade,
  type BoundaryRow,
} from '../lib/grade-boundaries.ts';

const row = (grade: string, minMark: number, year: number | null = 2025): BoundaryRow => ({
  grade, minMark, totalMarks: 100, source: 'published', year, session: 'May', paperNumber: 1,
});

const IB_ROWS = [row('7', 80), row('6', 68), row('5', 56), row('4', 43), row('3', 30), row('2', 18), row('1', 0)];

test('a target grade resolves to the published threshold', () => {
  const target = thresholdForGrade({ grade: '6', board: 'IB', rows: IB_ROWS });
  assert.ok(target);
  assert.equal(target.requiredPercent, 68);
  assert.equal(target.source, 'published');
  assert.equal(target.isFallback, false);
});

test('the newest session wins, exactly as the forward lookup does', () => {
  const target = thresholdForGrade({
    grade: '6',
    board: 'IB',
    rows: [...IB_ROWS, { ...row('6', 61, 2019) }],
  });
  assert.equal(target?.requiredPercent, 68, '2025 threshold, not 2019');
});

test('a grade off the board scale yields no threshold rather than a guess', () => {
  // An IB student whose stored target is the CAIE-shaped "A".
  assert.equal(thresholdForGrade({ grade: 'A', board: 'IB', rows: IB_ROWS }), null);
  assert.equal(thresholdForGrade({ grade: '7', board: 'CAIE', rows: [] }), null);
});

test('with no rows on file it falls back to a band, and says so', () => {
  const target = thresholdForGrade({ grade: '6', board: 'IB', rows: [] });
  assert.ok(target);
  assert.equal(target.isFallback, true);
  assert.equal(target.source, 'estimate');
  assert.equal(target.requiredPercent, 70);
});

test('rows that exist but not for the wanted grade still yield a band', () => {
  const target = thresholdForGrade({ grade: '7', board: 'IB', rows: [row('4', 43)] });
  assert.ok(target);
  assert.equal(target.isFallback, true);
});

test('isGradeOnScale separates the two scales', () => {
  assert.equal(isGradeOnScale('7', 'IB'), true);
  assert.equal(isGradeOnScale('A*', 'CAIE'), true);
  assert.equal(isGradeOnScale('A', 'IB'), false);
  assert.equal(isGradeOnScale('5', 'CAIE'), false);
});

test('required marks round up, because 61 does not reach 61.2', () => {
  const target = thresholdForGrade({ grade: '6', board: 'IB', rows: [
    { grade: '6', minMark: 34, totalMarks: 60, source: 'published', year: 2025, session: 'May', paperNumber: 1 },
  ] });
  assert.ok(target);
  // 34/60 of a 90-mark paper is 51.0; of an 80-mark paper 45.33 -> 46.
  const progress = progressToTarget({ marks: 40, totalMarks: 80, target });
  assert.ok(progress);
  assert.equal(progress.requiredMarks, 46);
  assert.equal(progress.shortfall, 6);
  assert.equal(progress.met, false);
});

test('meeting the target reports no shortfall', () => {
  const target = thresholdForGrade({ grade: '5', board: 'IB', rows: IB_ROWS });
  assert.ok(target);
  const progress = progressToTarget({ marks: 60, totalMarks: 100, target });
  assert.deepEqual([progress?.shortfall, progress?.met], [0, true]);
});

test('required marks never exceed the paper total', () => {
  const target = thresholdForGrade({ grade: '7', board: 'IB', rows: [
    { grade: '7', minMark: 100, totalMarks: 100, source: 'published', year: 2025, session: 'May', paperNumber: 1 },
  ] });
  assert.ok(target);
  const progress = progressToTarget({ marks: 0, totalMarks: 50, target });
  assert.equal(progress?.requiredMarks, 50);
});

test('a paper with no marks is not measurable', () => {
  const target = thresholdForGrade({ grade: '6', board: 'IB', rows: IB_ROWS });
  assert.ok(target);
  assert.equal(progressToTarget({ marks: 0, totalMarks: 0, target }), null);
});
