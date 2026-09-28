import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivePaperTemplates, chooseTemplate, MIN_PAPERS, type TemplateRow } from '../lib/paper-template-shape.ts';
import { fillSlots, topicShares } from '../lib/mock-exam-packing.ts';

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

const candidate = (id: number, marks: number, paperId = id, topicId: number | null = null) =>
  ({ id, marks, paperId, year: 2024, keyed: false, topicId });

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


test('a blueprint\'s slots spread across topics when they can', () => {
  // Same shape as the mark-total draw: the pool leans on topic 1, and the
  // quota pulls the paper back towards the subject's real spread. The slots
  // are all the same size so the only thing distinguishing the picks is topic.
  const slots = [
    { position: 1, marks: 5 },
    { position: 2, marks: 5 },
    { position: 3, marks: 5 },
    { position: 4, marks: 5 },
  ];
  const pool = [
    ...Array.from({ length: 10 }, (_, i) => candidate(100 + i, 5, 100 + i, 1)),
    candidate(200, 5, 200, 2),
    candidate(300, 5, 300, 3),
  ];
  // Topic 1 holds half the syllabus, so its running allowance over a
  // four-question paper is two -- and the pool's ten topic-1 questions cannot
  // take all four slots.
  const shares = topicShares([
    { topicId: 1, share: 0.5 },
    { topicId: 2, share: 0.25 },
    { topicId: 3, share: 0.25 },
  ]);

  const picked = fillSlots(slots, pool, shares);
  assert.equal(picked.length, 4, 'balancing must never leave a slot empty');
  const topics = new Set(picked.map((x) => x.topicId));
  assert.ok(topics.has(2) && topics.has(3), `expected topics 2 and 3, got ${[...topics]}`);
});

test('a slot is filled even when no topic has room left', () => {
  // The blueprint's shape outranks its topic spread: a missing question is
  // visible to a student and a slightly over-represented topic is not.
  const slots = [{ position: 1, marks: 5 }, { position: 2, marks: 5 }];
  const pool = [candidate(1, 5, 1, 1), candidate(2, 5, 2, 1)];
  // Topic 1 is the whole syllabus and the whole pool, so by the second slot
  // its allowance is spent and the slot has to overrun it.
  const picked = fillSlots(slots, pool, topicShares([{ topicId: 1, share: 1 }]));
  assert.equal(picked.length, 2);
});

// ---------------------------------------------------------------------------
// The board's figures reach both kinds of paper
// ---------------------------------------------------------------------------

/**
 * A source scan, because the wiring is the bug.
 *
 * Both halves of this were individually reasonable and wrong together. The
 * generator's form renders its mark and duration sliders only for a *custom*
 * total, so picking "Paper 3 - 80 marks, 1h 15m" left `totalMarks` and
 * `durationMinutes` at their useState defaults of 50 and 90. The plain mock
 * path never noticed, because the route re-derives everything from
 * `paperNumber`. The predicted path passed them straight to the model.
 *
 * So a student chose Physics Paper 3, read "The mark total and timing are the
 * ones in the Cambridge syllabus", and sat a 50-mark paper on a 90-minute
 * clock. Verified against production on 28 Sep 2026 before the fix.
 *
 * There is no unit to test here -- the decision is three assignments across two
 * files -- so this pins the assignments.
 */
const source = (relative: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', relative), 'utf8');

test('a predicted paper is built from the board\'s figures, not the form\'s defaults', () => {
  const route = source('app/api/mock-exams/generate/route.ts');
  const call = route.slice(
    route.indexOf('createPredictedPaper({'),
    route.indexOf('await recordUsage'),
  );
  assert.ok(call.length > 0, 'the predicted branch no longer calls createPredictedPaper');
  assert.match(
    call,
    /totalMarks:\s*examTotalMarks/,
    'the predicted paper is using a mark total other than the named paper\'s',
  );
  assert.match(
    call,
    /durationMinutes:\s*examDuration/,
    'the predicted paper is using a duration other than the board\'s clock',
  );
});

test('the paper format is resolved before the predicted branch, not after it', () => {
  const route = source('app/api/mock-exams/generate/route.ts');
  const branch = route.indexOf("if (mode === 'predicted')");
  assert.ok(branch > 0, 'the predicted branch moved');
  assert.ok(
    route.indexOf('const template =') < branch,
    'the template is resolved after the predicted branch, so only mock exams can use it',
  );
  assert.ok(
    route.indexOf('const examTotalMarks =') < branch,
    'examTotalMarks is resolved after the predicted branch',
  );
  // One definition, shared. Two would drift exactly as they did before.
  assert.equal(route.match(/const template = /g)?.length, 1);
  assert.equal(route.match(/const examDuration = /g)?.length, 1);
});

test('the generator sends the chosen paper\'s figures, not the custom sliders', () => {
  const form = source('app/components/MockExams.tsx');
  const start = form.indexOf("fetch('/api/mock-exams/generate'");
  assert.ok(start > 0, 'the generate request moved');
  // Searched from the call, not the file: an earlier `res.json()` elsewhere in
  // this component would otherwise slice backwards into nothing.
  const body = form.slice(start, form.indexOf('const data = await res.json()', start));
  assert.ok(body.length > 0, 'the generate request body could not be located');
  assert.match(body, /totalMarks:\s*selectedFormat\?\.totalMarks\s*\?\?\s*totalMarks/);
  assert.match(body, /durationMinutes:\s*selectedFormat\?\.minutes\s*\?\?\s*durationMinutes/);
});
