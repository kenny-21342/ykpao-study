import assert from 'node:assert/strict';
import { test } from 'node:test';

import { packToTarget, totalMarksOf, type SelectedQuestion } from '../lib/mock-exam-packing.ts';

/**
 * Packing a paper to its mark target.
 *
 * The database half of selection is a single indexed query; this is the half
 * with arithmetic in it, and the half that decides whether a generated paper
 * looks like an exam or like forty questions off one 2019 paper.
 */

const q = (id: number, marks: number, paperId = id, year = 2020): SelectedQuestion => ({
  id,
  marks,
  paperId,
  year,
});

test('packs up to the target without overshooting it', () => {
  const picked = packToTarget([q(1, 6), q(2, 8), q(3, 10), q(4, 4)], 20, 12);
  assert.ok(totalMarksOf(picked) <= 20, `overshot: ${totalMarksOf(picked)}`);
  assert.ok(totalMarksOf(picked) >= 16, `undershot badly: ${totalMarksOf(picked)}`);
});

test('never exceeds the item ceiling', () => {
  const many = Array.from({ length: 60 }, (_, i) => q(i + 1, 1));
  const picked = packToTarget(many, 50, 12);
  assert.equal(picked.length, 12);
});

test('never repeats a question', () => {
  const picked = packToTarget([q(1, 5), q(1, 5), q(2, 5), q(2, 5)], 50, 12);
  assert.deepEqual(
    picked.map((p) => p.id),
    [...new Set(picked.map((p) => p.id))],
  );
});

test('spreads across source papers before doubling up on one', () => {
  // Nine questions on paper 100, one each on 200 and 300. A naive draw takes
  // the crowded paper nine times; the first pass must reach the other two.
  const crowded = Array.from({ length: 9 }, (_, i) => q(i + 1, 2, 100));
  const picked = packToTarget([...crowded, q(50, 2, 200), q(51, 2, 300)], 6, 3);
  const papers = new Set(picked.map((p) => p.paperId));
  assert.equal(papers.size, 3, `expected three distinct papers, got ${[...papers].join(',')}`);
});

test('a target smaller than any question still yields a paper', () => {
  // Better one question over target than the empty result that reads to a
  // student as the "no questions available" failure this replaced.
  const picked = packToTarget([q(1, 9), q(2, 12)], 5, 12);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].marks, 9, 'should pick the smallest available');
});

test('an empty candidate list yields an empty paper', () => {
  assert.deepEqual(packToTarget([], 50, 12), []);
});

test('questions come back in reading order, not draw order', () => {
  const picked = packToTarget([q(3, 2, 30, 2022), q(1, 2, 10, 2018), q(2, 2, 20, 2020)], 10, 12);
  assert.deepEqual(
    picked.map((p) => p.year),
    [2018, 2020, 2022],
  );
});
