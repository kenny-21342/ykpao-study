import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOfficialFormat, type OfficialFormat } from '../lib/paper-format-overlay.ts';
import type { PaperTemplate } from '../lib/paper-template-shape.ts';

const template = (over: Partial<PaperTemplate> = {}): PaperTemplate => {
  const slots = over.slots ?? [
    { position: 1, marks: 7 }, { position: 2, marks: 8 }, { position: 3, marks: 8 },
  ];
  return {
    subjectCode: '0625', level: 'igcse', paperNumber: 4, papersObserved: 68,
    questionCount: slots.length,
    totalMarks: slots.reduce((sum, s) => sum + s.marks, 0),
    slots, style: 'structured', ...over, ...(over.slots ? { slots } : {}),
  };
};

const official = (over: Partial<OfficialFormat> = {}): OfficialFormat => ({
  name: 'Theory (Extended)', minutes: 75, marks: 80, weightingPercent: 50,
  source: 'cambridge-syllabus', ...over,
});

const total = (t: { slots: readonly { marks: number }[] }) =>
  t.slots.reduce((sum, s) => sum + s.marks, 0);

test('without official figures the template is returned untouched', () => {
  const measured = template();
  const out = applyOfficialFormat(measured, null);
  assert.equal(out.official, null);
  assert.equal(out.totalMarks, measured.totalMarks);
  assert.deepEqual(out.slots, measured.slots);
});

test('a rescaled ladder sums to exactly the official total', () => {
  // The whole point: the total is the one figure that is certainly right, so
  // rounding must never be allowed to miss it.
  for (const marks of [40, 50, 75, 80, 90, 100, 110, 150]) {
    const out = applyOfficialFormat(template(), official({ marks }));
    assert.equal(out.totalMarks, marks);
    assert.equal(total(out), marks, `slots must sum to ${marks}`);
  }
});

test('rescaling keeps the heavier question heavier', () => {
  const out = applyOfficialFormat(
    template({ slots: [{ position: 1, marks: 2 }, { position: 2, marks: 10 }] }),
    official({ marks: 60 }),
  );
  assert.ok(out.slots[1].marks > out.slots[0].marks, 'relative weight must survive');
  assert.equal(total(out), 60);
});

test('the rounding remainder goes to the questions that lost the most of it', () => {
  // Three equal slots over 100 marks cannot divide evenly; the extra mark must
  // land somewhere, and it must land once, not three times.
  const out = applyOfficialFormat(
    template({ slots: [{ position: 1, marks: 5 }, { position: 2, marks: 5 }, { position: 3, marks: 5 }] }),
    official({ marks: 100 }),
  );
  assert.equal(total(out), 100);
  assert.deepEqual(out.slots.map((s) => s.marks).sort((a, b) => a - b), [33, 33, 34]);
});

test('no question is ever worth zero marks, even when the paper is short', () => {
  // IGCSE History Paper 4 is the real case: thirteen measured questions
  // against an official 40 marks, and earlier a measured total of 520.
  const slots = Array.from({ length: 13 }, (_, i) => ({ position: i + 1, marks: 40 }));
  const out = applyOfficialFormat(template({ slots }), official({ marks: 40 }));
  assert.equal(total(out), 40);
  assert.ok(out.slots.every((s) => s.marks >= 1), 'a zero-mark question is not a question');

  // And when the official total is smaller than the question count, every slot
  // still gets its mark rather than the paper collapsing.
  const tiny = applyOfficialFormat(template({ slots }), official({ marks: 5 }));
  assert.ok(tiny.slots.every((s) => s.marks === 1));
});

test('a measured total that already matches is left alone, not re-derived', () => {
  const measured = template();                       // 23 marks
  const out = applyOfficialFormat(measured, official({ marks: 23 }));
  assert.equal(out.official?.rescaled, false);
  assert.deepEqual(out.slots, measured.slots, 'an exact match must not be disturbed');
});

test('a multiple-choice paper is rebuilt, because its total IS its length', () => {
  // Measured gave Physics 0625 Paper 1 as 38 questions worth 9 marks between
  // them, since a keyed question carries no mark of its own. The real paper is
  // 40 questions of one mark. So here the official figure fixes the length too.
  const out = applyOfficialFormat(
    template({ style: 'mcq', paperNumber: 1, slots: [{ position: 1, marks: 1 }, { position: 2, marks: 1 }] }),
    official({ name: 'Multiple Choice (Extended)', marks: 40, minutes: 45 }),
  );
  assert.equal(out.questionCount, 40);
  assert.equal(out.totalMarks, 40);
  assert.equal(total(out), 40);
  assert.ok(out.slots.every((s) => s.marks === 1), 'every MCQ is worth one mark');
  assert.deepEqual(out.slots.map((s) => s.position).slice(0, 3), [1, 2, 3]);
});

test('the board name, duration and provenance are carried through for the UI', () => {
  const out = applyOfficialFormat(template(), official());
  assert.equal(out.official?.name, 'Theory (Extended)');
  assert.equal(out.official?.minutes, 75);
  assert.equal(out.official?.source, 'cambridge-syllabus');
  assert.equal(out.official?.rescaled, true);
});

test('a paper the board prints no duration for keeps a null, not a guess', () => {
  // Cambridge coursework and every IB Language A paper. Inventing a duration
  // here would put a countdown clock on a paper that has none.
  const out = applyOfficialFormat(template(), official({ minutes: null, name: 'Coursework' }));
  assert.equal(out.official?.minutes, null);
  assert.equal(out.totalMarks, 80);
});

test('positions stay contiguous from one after a rescale', () => {
  const out = applyOfficialFormat(template(), official({ marks: 80 }));
  assert.deepEqual(out.slots.map((s) => s.position), [1, 2, 3]);
});

test('a shape that cannot carry its official total is flagged, not silently used', () => {
  // The real case: our extraction merged every IB Maths AI Paper 1 into one
  // question, so the measurement reports a single position. Rescaling that
  // faithfully gives one question worth 110 marks, which is not a paper --
  // and, unlike random packing, it looks deliberate.
  const merged = applyOfficialFormat(
    template({ subjectCode: 'mathematics-applications-and-interpretation', level: 'HL',
               paperNumber: 1, slots: [{ position: 1, marks: 7 }] }),
    official({ name: 'Paper 1', marks: 110, minutes: 120, source: 'ib-paper-cover' }),
  );
  assert.equal(merged.shapeCredible, false);
  // The official figures are still carried, so a caller can report them even
  // while refusing to generate against the shape.
  assert.equal(merged.official?.marks, 110);
});

test('genuinely heavy papers stay credible', () => {
  // IB Maths AA HL Paper 3 really is two questions of about 27 marks, and
  // IGCSE History Paper 4 really is one worth 40. Neither is an extraction
  // failure, so the guard must not reject them.
  const p3 = applyOfficialFormat(
    template({ slots: [{ position: 1, marks: 20 }, { position: 2, marks: 20 }] }),
    official({ marks: 55 }),
  );
  assert.equal(p3.shapeCredible, true);
  assert.equal(p3.totalMarks, 55);

  const history = applyOfficialFormat(
    template({ subjectCode: '0470', paperNumber: 4, slots: [{ position: 1, marks: 12 }] }),
    official({ name: 'Alternative to Coursework', marks: 40, minutes: 60 }),
  );
  assert.equal(history.shapeCredible, true);
});

test('credibility is judged after rescaling, not before', () => {
  // Thirteen questions each measured at 40 marks (the 520-mark History bug)
  // would fail the cap as measured, and pass it once the official total is
  // applied. The guard has to see the corrected ladder or it rejects exactly
  // the papers this module fixes.
  const slots = Array.from({ length: 13 }, (_, i) => ({ position: i + 1, marks: 40 }));
  const out = applyOfficialFormat(template({ slots }), official({ marks: 40 }));
  assert.equal(out.shapeCredible, true);
  assert.equal(out.totalMarks, 40);
});

test('an uncorrected template is judged on its own marks', () => {
  const slots = Array.from({ length: 13 }, (_, i) => ({ position: i + 1, marks: 40 }));
  assert.equal(applyOfficialFormat(template({ slots }), null).shapeCredible, false);
  assert.equal(applyOfficialFormat(template(), null).shapeCredible, true);
});
