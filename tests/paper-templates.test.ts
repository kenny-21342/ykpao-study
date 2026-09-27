import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePaperTemplates, chooseTemplate, MIN_PAPERS, type TemplateRow } from '../lib/paper-template-shape.ts';
import { fillSlots } from '../lib/mock-exam-packing.ts';

/**
 * Shaped after the real measurement of Physics 0625 Paper 4 on 27 Sep 2026:
 * ~68 papers, nine questions of seven or eight marks, a tenth position in 26
 * of them and an eleventh in two.
 */
const row = (over: Partial<TemplateRow> = {}): TemplateRow => ({
  level: 'igcse', paperNumber: 4, position: 1,
  papersObserved: 68, positionSeen: 60,
  medianQuestions: 9, medianMarks: 8, groupMedianMarks: 8, keyedFraction: 0,
  ...over,
});

test('the template is the median paper, not the longest one ever extracted', () => {
  /**
   * The bug this prevents, taken from the real data: position 10 appears in
   * 26 of 68 papers and position 11 in two, because extraction occasionally
   * runs past the end. An unguarded template would generate an eleven-question
   * Paper 4, which no real sitting has looked like.
   */
  const rows = [
    ...Array.from({ length: 9 }, (_, i) => row({ position: i + 1 })),
    row({ position: 10, positionSeen: 26 }),
    row({ position: 11, positionSeen: 2 }),
  ];
  const [template] = derivePaperTemplates('0625', rows);
  assert.equal(template.questionCount, 9);
  assert.equal(template.slots.at(-1)?.position, 9);
});

test('a position most papers do have survives the quorum', () => {
  // The guard must not be so tight that it trims real questions: the median
  // question count already caps the length, and this only removes rarities
  // inside it.
  const rows = Array.from({ length: 9 }, (_, i) =>
    row({ position: i + 1, positionSeen: i === 8 ? 40 : 60, medianQuestions: 9 }));
  const [template] = derivePaperTemplates('0625', rows);
  assert.equal(template.questionCount, 9);
});

test('a group with too few papers is not a measurement', () => {
  const rows = Array.from({ length: 9 }, (_, i) =>
    row({ position: i + 1, papersObserved: MIN_PAPERS - 1 }));
  assert.deepEqual(derivePaperTemplates('0625', rows), []);
});

test('slots are renumbered so a trimmed position leaves no hole', () => {
  // Position 2 fails the quorum. The paper that results must be questions
  // 1, 2, 3 — not 1, 3, 4 with a gap where a student looks for a question.
  const rows = [
    row({ position: 1 }), row({ position: 2, positionSeen: 1 }),
    row({ position: 3 }), row({ position: 4 }),
  ].map((r) => ({ ...r, medianQuestions: 4 }));
  const [template] = derivePaperTemplates('0625', rows);
  assert.deepEqual(template.slots.map((s) => s.position), [1, 2, 3]);
});

test('a position with no mark data borrows the group median rather than vanishing', () => {
  // The question exists in every real paper; a hole in our extraction is not
  // a hole in the exam, and dropping it would shorten the paper for a reason
  // that has nothing to do with the exam.
  const rows = Array.from({ length: 3 }, (_, i) =>
    row({ position: i + 1, medianQuestions: 3, medianMarks: i === 1 ? null : 8 }));
  const [template] = derivePaperTemplates('0625', rows);
  assert.deepEqual(template.slots.map((s) => s.marks), [8, 8, 8]);
});

test('a keyed paper is multiple choice and a written one is not', () => {
  const mcq = derivePaperTemplates('0625', [row({ medianQuestions: 1, medianMarks: 1, keyedFraction: 0.97 })]);
  assert.equal(mcq[0].style, 'mcq');
  const structured = derivePaperTemplates('0625', [row({ medianQuestions: 1, keyedFraction: 0.1 })]);
  assert.equal(structured[0].style, 'structured');
});

test('levels are matched across two vocabularies written years apart', () => {
  /**
   * A course says "A Level"; `bank_subjects` says "a-level". A raw comparison
   * matched neither, and because `chooseTemplate` falls back to every template
   * when a level matches nothing, the failure was invisible — an A-level
   * student would silently have been offered some other level's papers.
   */
  const templates = derivePaperTemplates('9708', [
    row({ level: 'a-level', paperNumber: 2, medianQuestions: 1, medianMarks: 20 }),
    row({ level: 'as-level', paperNumber: 2, medianQuestions: 1, medianMarks: 10 }),
  ]);
  assert.equal(chooseTemplate(templates, { level: 'A Level', paperNumber: 2 })?.totalMarks, 20);
  assert.equal(chooseTemplate(templates, { level: 'AS Level', paperNumber: 2 })?.totalMarks, 10);
});

test('with no paper named, the biggest paper is the one a student means', () => {
  // Paper 1 is usually a multiple-choice screen and the last papers are
  // practicals that do not transfer to a screen at all.
  const templates = derivePaperTemplates('0625', [
    row({ paperNumber: 1, medianQuestions: 1, medianMarks: 1, keyedFraction: 1 }),
    row({ paperNumber: 4, medianQuestions: 1, medianMarks: 70 }),
    row({ paperNumber: 6, medianQuestions: 1, medianMarks: 33 }),
  ]);
  assert.equal(chooseTemplate(templates)?.paperNumber, 4);
});

const candidate = (id: number, marks: number, paperId = id) => ({ id, marks, paperId, year: 2024, keyed: false });

test('every slot takes an exact mark match when one exists', () => {
  const slots = [{ position: 1, marks: 8 }, { position: 2, marks: 7 }];
  const picked = fillSlots(slots, [candidate(1, 3), candidate(2, 7), candidate(3, 8)]);
  assert.deepEqual(picked.map((p) => p.marks), [8, 7]);
});

test('exact matches are exhausted before any slot settles for a near miss', () => {
  /**
   * The ordering rule. Widening slot by slot would let slot 1 take the only
   * 7-mark question as its near miss, leaving slot 2 — which needed exactly 7
   * — with nothing. Both slots end up approximate for no reason.
   */
  const slots = [{ position: 1, marks: 8 }, { position: 2, marks: 7 }];
  const picked = fillSlots(slots, [candidate(1, 7), candidate(2, 8)]);
  assert.deepEqual(picked.map((p) => p.marks), [8, 7]);
});

test('a paper is not reprinted: slots prefer questions from different papers', () => {
  const slots = [{ position: 1, marks: 5 }, { position: 2, marks: 5 }];
  const picked = fillSlots(slots, [
    candidate(1, 5, 100), candidate(2, 5, 100), candidate(3, 5, 200),
  ]);
  assert.equal(new Set(picked.map((p) => p.paperId)).size, 2);
});

test('one paper is still better than a short paper', () => {
  // The spread is a preference, never a reason to leave a slot empty.
  const slots = [{ position: 1, marks: 5 }, { position: 2, marks: 5 }];
  const picked = fillSlots(slots, [candidate(1, 5, 100), candidate(2, 5, 100)]);
  assert.equal(picked.length, 2);
});

test('no question is used twice', () => {
  const slots = [{ position: 1, marks: 5 }, { position: 2, marks: 5 }, { position: 3, marks: 5 }];
  const picked = fillSlots(slots, [candidate(1, 5), candidate(2, 5)]);
  assert.equal(new Set(picked.map((p) => p.id)).size, picked.length);
});

test('paper 0 is not offered, because it is not a paper', () => {
  // The filename parser emits paper number 0 for a document that states none.
  // The only subject it clears MIN_PAPERS for is Art & Design 0400, which sets
  // no written paper at all, so the blueprint read "Paper 0, 6 marks".
  const templates = derivePaperTemplates('0400', [
    row({ paperNumber: 0, position: 1, medianQuestions: 6, medianMarks: 1 }),
    row({ paperNumber: 0, position: 2, medianQuestions: 6, medianMarks: 1 }),
  ]);
  assert.equal(templates.length, 0);

  // A real paper number is untouched by the guard.
  assert.equal(derivePaperTemplates('0625', [row({ paperNumber: 4 })]).length, 1);
});
