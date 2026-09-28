import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  packToTarget,
  topicAllowance,
  topicShares,
  totalMarksOf,
  type SelectedQuestion,
} from '../lib/mock-exam-packing.ts';

/**
 * Packing a paper to its mark target.
 *
 * The database half of selection is a single indexed query; this is the half
 * with arithmetic in it, and the half that decides whether a generated paper
 * looks like an exam or like forty questions off one 2019 paper.
 */

const q = (
  id: number,
  marks: number,
  paperId = id,
  year = 2020,
  keyed = true,
  topicId: number | null = null,
): SelectedQuestion => ({
  id,
  marks,
  paperId,
  year,
  keyed,
  topicId,
});

/** A question tagged with a topic, for the balance tests at the foot of this file. */
const tagged = (id: number, marks: number, topicId: number, paperId = id): SelectedQuestion =>
  q(id, marks, paperId, 2020, true, topicId);

/** A question with no answer key, so one that costs a model call to mark. */
const unkeyed = (id: number, marks: number, paperId = id, year = 2020): SelectedQuestion =>
  q(id, marks, paperId, year, false);

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

test('the unkeyed cap bounds grading cost without shrinking the paper', () => {
  // Twelve is the model-shaped ceiling; keyed questions cost nothing to mark,
  // so they must keep filling the paper after it is reached. The defect this
  // guards against is the reverse: a 50-mark request coming back as eight
  // one-mark questions because the item cap bound before the mark target did.
  const candidates = [
    ...Array.from({ length: 30 }, (_, i) => unkeyed(i + 1, 1)),
    ...Array.from({ length: 60 }, (_, i) => q(i + 101, 1)),
  ];
  const picked = packToTarget(candidates, 50, 60, 12);

  assert.equal(totalMarksOf(picked), 50, 'the mark target must still be met');
  assert.ok(
    picked.filter((p) => !p.keyed).length <= 12,
    'no more than twelve questions may need a model',
  );
});

test('a paper of only unkeyed questions still respects the model ceiling', () => {
  const candidates = Array.from({ length: 40 }, (_, i) => unkeyed(i + 1, 1));
  const picked = packToTarget(candidates, 50, 60, 12);
  assert.equal(picked.length, 12);
});


// ---------------------------------------------------------------------------
// Topic balance
// ---------------------------------------------------------------------------

/** The real IGCSE Physics split, measured over 7,205 eligible questions. */
const PHYSICS = [
  { topicId: 1, share: 0.331 }, // Motion, forces and energy
  { topicId: 2, share: 0.266 }, // Electricity and magnetism
  { topicId: 3, share: 0.197 }, // Waves
  { topicId: 4, share: 0.159 }, // Thermal physics
  { topicId: 5, share: 0.042 }, // Nuclear physics
  { topicId: 6, share: 0.005 }, // Space physics
];

test('a topic\'s allowance grows with the paper it is in', () => {
  // The reason this is a running limit and not a quota: how many questions a
  // paper ends up holding is not known when the draw begins.
  assert.equal(topicAllowance(0.331, 4), 2);
  assert.equal(topicAllowance(0.331, 8), 3);
  assert.equal(topicAllowance(0.331, 12), 4);
  // Never a larger share of the paper than of the syllabus by more than one
  // question's worth of rounding.
  for (const size of [1, 2, 3, 5, 8, 12, 20, 40]) {
    assert.ok(topicAllowance(0.331, size) <= Math.ceil(0.331 * size));
  }
});

test('any topic may open a paper, however light it is in the syllabus', () => {
  // Space physics is 0.5% of IGCSE Physics -- a sixteenth of one question in a
  // twelve-question paper. Flooring the allowance at zero would have made it
  // unpickable in tiers 0 and 1 forever.
  assert.equal(topicAllowance(0.005, 12), 1);
  assert.equal(topicAllowance(0, 12), 1);
});

test('shares are keyed for lookup exactly as measured', () => {
  const shares = topicShares(PHYSICS);
  assert.equal(shares.get(1), 0.331);
  assert.equal(shares.get(6), 0.005);
  assert.equal(shares.size, 6);
});

test('a paper spreads across topics instead of following the bank\'s own lean', () => {
  /**
   * The whole feature. The candidate pool leans on topic 1 exactly as the real
   * bank does -- a topic holding 50% of the marks is 50% of a random draw --
   * and eight questions is a small enough sample that an unbalanced draw
   * routinely returns a paper that is nearly all of one topic.
   */
  const candidates = [
    ...Array.from({ length: 20 }, (_, i) => tagged(100 + i, 5, 1)),
    ...Array.from({ length: 4 }, (_, i) => tagged(200 + i, 5, 2)),
    ...Array.from({ length: 4 }, (_, i) => tagged(300 + i, 5, 3)),
  ];
  const shares = topicShares([
    { topicId: 1, share: 0.5 },
    { topicId: 2, share: 0.25 },
    { topicId: 3, share: 0.25 },
  ]);

  const balanced = packToTarget(candidates, 40, 8, 8, shares);
  assert.equal(totalMarksOf(balanced), 40, 'balancing must not cost the paper its mark target');

  const byTopic = new Map<number, number>();
  for (const picked of balanced) {
    byTopic.set(picked.topicId!, (byTopic.get(picked.topicId!) ?? 0) + picked.marks);
  }
  assert.ok(byTopic.get(2)! > 0, 'topic 2 is absent from a balanced paper');
  assert.ok(byTopic.get(3)! > 0, 'topic 3 is absent from a balanced paper');
  assert.ok(
    byTopic.get(1)! <= 20,
    `topic 1 took ${byTopic.get(1)} of 40 marks against a 50% syllabus share`,
  );

  // And without shares the same pool is free to lean, which is what it did
  // before this existed -- asserted so the test is measuring the balance and
  // not an accident of the fixture's ordering.
  const unbalanced = packToTarget(candidates, 40, 8, 8);
  assert.ok(
    unbalanced.every((picked) => picked.topicId === 1),
    'the fixture no longer demonstrates the lean it exists to demonstrate',
  );
});

test('balance never leaves a paper short of its target', () => {
  // Three topics claimed by the weights, but the pool only offers one. Tiers 0
  // and 1 run dry and the paper is finished from tiers 2 and 3.
  const candidates = Array.from({ length: 10 }, (_, i) => tagged(i + 1, 5, 1));
  const shares = topicShares([
    { topicId: 1, share: 0.34 },
    { topicId: 2, share: 0.33 },
    { topicId: 3, share: 0.33 },
  ]);
  assert.equal(totalMarksOf(packToTarget(candidates, 30, 6, 6, shares)), 30);
});

test('untagged questions still fill a paper balance cannot', () => {
  // 6.2% of eligible questions carry no topic. They can only be taken in the
  // unbalanced tiers -- but they must still be taken rather than leaving the
  // paper short.
  const candidates = [tagged(1, 10, 1), q(2, 10), q(3, 10)];
  const picked = packToTarget(candidates, 30, 3, 3, topicShares([{ topicId: 1, share: 1 }]));
  assert.equal(totalMarksOf(picked), 30);
  assert.equal(picked.filter((x) => x.topicId === null).length, 2);
});

test('no shares means topics are ignored entirely', () => {
  const candidates = [tagged(1, 10, 1, 1), tagged(2, 10, 1, 2), tagged(3, 10, 1, 3)];
  assert.deepEqual(
    packToTarget(candidates, 30, 3, 3, undefined).map((x) => x.id),
    packToTarget(candidates, 30, 3, 3).map((x) => x.id),
  );
});

test('a mark target is reached even when the bank is mostly one-mark questions', () => {
  /**
   * The pre-existing defect this fixed. The corpus is 75% one-mark multiple
   * choice and `maxItems` binds long before `targetMarks` does, so taking
   * candidates in draw order spent all twelve slots on one-mark questions and
   * returned a 50-mark paper holding 12 marks.
   */
  const candidates = [
    ...Array.from({ length: 60 }, (_, i) => q(i + 1, 1, i + 1)),
    ...Array.from({ length: 6 }, (_, i) => q(100 + i, 8, 100 + i)),
  ];
  const picked = packToTarget(candidates, 50, 12, 12);
  assert.ok(
    totalMarksOf(picked) >= 48,
    `reached only ${totalMarksOf(picked)} of 50 marks in 12 items`,
  );
});

test('a full-length paper, not a handful of the biggest questions', () => {
  /**
   * The other half of the same fix, and the reason the wanted size is derived
   * rather than "as large as possible". Two subjects' banks hold nothing
   * between 1 mark and 11, so filling fifty marks with the largest available
   * questions is four or five of them -- a paper that hits its target and
   * covers four topics. Deriving the wanted size from the marks still missing
   * over the slots still free mixes the two sizes instead: here, four 11-mark
   * questions and six 1-mark ones. Ten, not twelve, because 11a + b = 50 with
   * a + b = 12 has no whole-number answer -- the item cap is a ceiling, and the
   * target is what the student asked for.
   */
  const candidates = [
    ...Array.from({ length: 60 }, (_, i) => q(i + 1, 1, i + 1)),
    ...Array.from({ length: 20 }, (_, i) => q(100 + i, 11, 100 + i)),
  ];
  const picked = packToTarget(candidates, 50, 12, 12);
  assert.equal(totalMarksOf(picked), 50);
  assert.ok(
    picked.length >= 10,
    `a 50-mark paper came back as ${picked.length} questions; big-first gave 4 to 5`,
  );
});

test('size ordering does not make the paper predictable', () => {
  // Which questions are in the pool is ORDER BY random() in SQL; only which of
  // them is preferred is decided here. Two different draws of the same shape
  // must still produce different papers.
  const poolA = Array.from({ length: 12 }, (_, i) => q(i + 1, 5, i + 1));
  const poolB = Array.from({ length: 12 }, (_, i) => q(i + 101, 5, i + 101));
  assert.notDeepEqual(
    packToTarget(poolA, 30, 6, 6).map((x) => x.id),
    packToTarget(poolB, 30, 6, 6).map((x) => x.id),
  );
});
