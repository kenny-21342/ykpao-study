import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  boardForSubjectCode,
  gradeFromBoundaries,
  gradeSourceLabel,
  scaleForBoard,
  type BoundaryRow,
} from '../lib/grade-boundaries.ts';

/**
 * Turning a mark into a grade.
 *
 * The result screen used a fixed percentage ladder for every subject, which
 * told IB students -- graded 1-7 -- that they had got a "B". These pin the two
 * things that must not regress: the scale follows the board, and a grade never
 * claims to come from a real threshold when it does not.
 */

const row = (grade: string, minMark: number, over = 100, extra: Partial<BoundaryRow> = {}): BoundaryRow => ({
  grade, minMark, totalMarks: over, source: 'published', year: 2025, session: 's', paperNumber: 1, ...extra,
});

test('an IB subject is graded 1-7, never a letter', () => {
  const result = gradeFromBoundaries({ marks: 40, totalMarks: 50, board: 'IB', rows: [] });
  assert.equal(result.scale, 'ib');
  assert.match(result.grade, /^[1-7]$/, `got ${result.grade}`);
});

test('a CAIE subject is graded on letters', () => {
  const result = gradeFromBoundaries({ marks: 40, totalMarks: 50, board: 'CAIE', rows: [] });
  assert.equal(result.scale, 'caie');
  assert.ok(['A*', 'A', 'B', 'C', 'D', 'E'].includes(result.grade), `got ${result.grade}`);
});

test('a real threshold is used when one is on file', () => {
  const rows = [row('A', 60), row('B', 50), row('C', 40)];
  // 55/100 clears B but not A, whatever a 70/60/50 ladder would have said.
  const result = gradeFromBoundaries({ marks: 55, totalMarks: 100, board: 'CAIE', rows });
  assert.equal(result.grade, 'B');
  assert.equal(result.source, 'published');
  assert.equal(result.isFallback, false);
});

test('boundaries are compared proportionally, not by raw mark', () => {
  // Published against a 100-mark paper; the student sat a 20-mark mock.
  const rows = [row('A', 60), row('B', 50), row('C', 40)];
  const result = gradeFromBoundaries({ marks: 12, totalMarks: 20, board: 'CAIE', rows });
  assert.equal(result.grade, 'A', 'a 60% score should reach the 60% boundary');
});

test('the most recent session wins over an older one', () => {
  const rows = [
    row('A', 80, 100, { year: 2019 }),
    row('B', 70, 100, { year: 2019 }),
    row('A', 60, 100, { year: 2025 }),
    row('B', 50, 100, { year: 2025 }),
  ];
  const result = gradeFromBoundaries({ marks: 62, totalMarks: 100, board: 'CAIE', rows });
  assert.equal(result.grade, 'A', 'the 2025 threshold should have been used');
});

test('a mark below every boundary gets the lowest grade, not nothing', () => {
  const rows = [row('A', 60), row('B', 50), row('C', 40)];
  const result = gradeFromBoundaries({ marks: 1, totalMarks: 100, board: 'CAIE', rows });
  assert.equal(result.grade, 'E');
});

test('with no boundaries on file the grade is flagged as an estimate', () => {
  const result = gradeFromBoundaries({ marks: 55, totalMarks: 100, board: 'CAIE', rows: [] });
  assert.equal(result.source, 'estimate');
  assert.equal(result.isFallback, true);
  assert.match(gradeSourceLabel(result), /Estimated/);
});

test('a school-supplied boundary is reported as such, not as published', () => {
  const rows = [row('7', 70, 100, { source: 'school' }), row('6', 60, 100, { source: 'school' })];
  const result = gradeFromBoundaries({ marks: 75, totalMarks: 100, board: 'IB', rows });
  assert.equal(result.grade, '7');
  assert.equal(result.source, 'school');
  assert.match(gradeSourceLabel(result), /School/);
});

test('a zero-mark paper does not divide by zero', () => {
  const result = gradeFromBoundaries({ marks: 0, totalMarks: 0, board: 'CAIE', rows: [] });
  assert.equal(result.grade, 'E');
  assert.equal(result.isFallback, true);
});

test('rows for the wrong scale are ignored rather than awarded', () => {
  // Letter boundaries filed against an IB subject: unusable, so the IB
  // fallback bands must run instead of awarding an "A".
  const rows = [row('A', 60), row('B', 50)];
  const result = gradeFromBoundaries({ marks: 90, totalMarks: 100, board: 'IB', rows });
  assert.match(result.grade, /^[1-7]$/, `got ${result.grade}`);
  assert.equal(result.isFallback, true);
});

test('the board is resolved from the catalogue subject code', () => {
  assert.equal(boardForSubjectCode('0610'), 'CAIE');
  assert.equal(boardForSubjectCode('ib-biology'), 'IB');
  // The bank stores some IB subjects with the prefix stripped.
  assert.equal(boardForSubjectCode('biology'), 'IB');
  assert.equal(boardForSubjectCode('9999'), null);
});

test('the scale follows the board, whatever its casing', () => {
  assert.equal(scaleForBoard('IB'), 'ib');
  assert.equal(scaleForBoard('ib'), 'ib');
  assert.equal(scaleForBoard('CAIE'), 'caie');
});
