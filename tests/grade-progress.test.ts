import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MIN_SAMPLES, SAMPLE_WINDOW, progressFromRows, progressLabel, progressTowardTarget } from '../lib/grade-progress.ts';
import { thresholdForGrade, type BoundaryRow } from '../lib/grade-boundaries.ts';

const IB_ROWS: BoundaryRow[] = [
  { grade: '7', minMark: 80, totalMarks: 100, source: 'published', year: 2025, session: 'May', paperNumber: 1 },
  { grade: '6', minMark: 68, totalMarks: 100, source: 'published', year: 2025, session: 'May', paperNumber: 1 },
  { grade: '5', minMark: 56, totalMarks: 100, source: 'published', year: 2025, session: 'May', paperNumber: 1 },
];
const target6 = thresholdForGrade({ grade: '6', board: 'IB', rows: IB_ROWS })!;

const paper = (score: number, day: number) => ({ score, totalMarks: 100, submittedAt: `2026-09-${String(day).padStart(2, '0')}` });

test('no target means no progress object at all', () => {
  assert.equal(progressTowardTarget({ samples: [paper(70, 1)], target: null }), null);
});

test('one paper is not a trend', () => {
  const progress = progressTowardTarget({ samples: [paper(30, 1)], target: target6 });
  assert.equal(progress?.status, 'insufficient-data');
  assert.equal(progress?.averagePercent, null);
  assert.equal(progress?.sampleCount, 1);
});

test('the minimum basis is two marked papers', () => {
  assert.equal(MIN_SAMPLES, 2);
  const progress = progressTowardTarget({ samples: [paper(70, 1), paper(72, 2)], target: target6 });
  assert.equal(progress?.status, 'on-track');
  assert.equal(progress?.averagePercent, 71);
});

test('meeting the threshold is on track; just under is close; well under is at risk', () => {
  const at = (pct: number) => progressTowardTarget({ samples: [paper(pct, 1), paper(pct, 2)], target: target6 })?.status;
  assert.equal(at(68), 'on-track');
  assert.equal(at(64), 'close');      // 4 points short
  assert.equal(at(63), 'close');      // 5 points short, the boundary of the band
  assert.equal(at(62), 'at-risk');    // 6 points short
});

test('only the most recent papers count', () => {
  assert.equal(SAMPLE_WINDOW, 5);
  const samples = [
    paper(20, 1), paper(20, 2), paper(20, 3),   // old and bad
    paper(90, 10), paper(90, 11), paper(90, 12), paper(90, 13), paper(90, 14),
  ];
  const progress = progressTowardTarget({ samples, target: target6 });
  assert.equal(progress?.sampleCount, 5);
  assert.equal(progress?.averagePercent, 90, 'the three old papers must fall outside the window');
});

test('order of the input does not matter, only the dates', () => {
  const samples = [paper(40, 1), paper(90, 20)];
  const forward = progressTowardTarget({ samples, target: target6 });
  const reversed = progressTowardTarget({ samples: [...samples].reverse(), target: target6 });
  assert.equal(forward?.averagePercent, reversed?.averagePercent);
});

test('papers with no total marks are ignored rather than counted as zero', () => {
  const progress = progressTowardTarget({
    samples: [paper(70, 1), paper(72, 2), { score: 0, totalMarks: 0, submittedAt: '2026-09-03' }],
    target: target6,
  });
  assert.equal(progress?.sampleCount, 2);
  assert.equal(progress?.status, 'on-track');
});

test('papers of different totals are compared proportionally', () => {
  const progress = progressTowardTarget({
    samples: [
      { score: 34, totalMarks: 40, submittedAt: '2026-09-01' },  // 85%
      { score: 60, totalMarks: 80, submittedAt: '2026-09-02' },  // 75%
    ],
    target: target6,
  });
  assert.equal(progress?.averagePercent, 80);
});

test('labels say something a student can act on', () => {
  const none = progressTowardTarget({ samples: [], target: target6 })!;
  assert.match(progressLabel(none), /sit a mock exam/);
  const one = progressTowardTarget({ samples: [paper(70, 1)], target: target6 })!;
  assert.match(progressLabel(one), /one more mock exam/);
  const behind = progressTowardTarget({ samples: [paper(50, 1), paper(50, 2)], target: target6 })!;
  assert.match(progressLabel(behind), /need 68%/);
  const ok = progressTowardTarget({ samples: [paper(70, 1), paper(72, 2)], target: target6 })!;
  assert.match(progressLabel(ok), /On track for 6/);
});

test('progressFromRows resolves the target itself', () => {
  const progress = progressFromRows({
    samples: [paper(70, 1), paper(72, 2)],
    targetGrade: '6',
    board: 'IB',
    rows: IB_ROWS,
  });
  assert.equal(progress?.status, 'on-track');
  assert.equal(progress?.target.requiredPercent, 68);
});

test('a target off the board scale produces nothing, not a wrong prediction', () => {
  assert.equal(progressFromRows({ samples: [paper(70, 1), paper(72, 2)], targetGrade: 'A', board: 'IB', rows: IB_ROWS }), null);
});
