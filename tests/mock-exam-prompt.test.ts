import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidateList,
  buildSelectionPrompt,
  CANDIDATE_PREVIEW_CHARS,
  formatCandidate,
  MAX_CANDIDATES,
  previewOf,
  type SelectionCandidate,
} from '../lib/mock-exam-prompt.ts';
import { MAX_EXAM_ITEMS } from '../lib/mock-exam-limits.ts';

const candidate = (over: Partial<SelectionCandidate> = {}): SelectionCandidate => ({
  id: 4812,
  year: 2024,
  marks: 6,
  topic: 'Electricity',
  content: 'A circuit contains a 12 V cell and two resistors in series.',
  ...over,
});

test('a candidate is one line carrying id, marks, year and topic', () => {
  assert.equal(
    formatCandidate(candidate()),
    '4812 [6m] 2024 Electricity: A circuit contains a 12 V cell and two resistors in series.',
  );
});

test('newlines in question text never break the one-line-per-candidate contract', () => {
  // Extracted question text carries newlines and indentation. A raw newline
  // here would silently turn one candidate into two malformed ones.
  const messy = candidate({ content: 'Line one\n\n   Line two\tand\rmore' });
  const line = formatCandidate(messy);
  assert.ok(!line.includes('\n'), line);
  assert.match(line, /Line one Line two and more/);
});

test('every candidate produces exactly one line', () => {
  const list = buildCandidateList([
    candidate({ id: 1, content: 'a\nb' }),
    candidate({ id: 2, content: 'c\nd' }),
    candidate({ id: 3 }),
  ]);
  assert.equal(list.split('\n').length, 3);
});

test('long questions are cut to the preview length and marked as cut', () => {
  const preview = previewOf('x'.repeat(400));
  assert.ok(preview.length <= CANDIDATE_PREVIEW_CHARS + 1, `${preview.length}`);
  assert.ok(preview.endsWith('…'));
});

test('a short question is not padded or ellipsised', () => {
  assert.equal(previewOf('Short one.'), 'Short one.');
});

test('a missing topic falls back rather than printing empty', () => {
  assert.match(formatCandidate(candidate({ topic: '  ' })), /2024 General:/);
});

test('the prompt names the line format so the ids are unambiguous', () => {
  const prompt = buildSelectionPrompt({
    subjectName: 'Physics',
    subjectCode: '0625',
    totalMarks: 60,
    durationMinutes: 75,
    difficulty: 'medium',
    topics: [],
    targetCount: 10,
    candidates: [candidate()],
  });
  assert.match(prompt, /id \[marks\] year topic: preview/);
  assert.match(prompt, /^4812 \[6m\]/m);
  assert.doesNotMatch(prompt, /Focus topics/);
});

test('focus topics appear only when asked for', () => {
  const prompt = buildSelectionPrompt({
    subjectName: 'Physics',
    subjectCode: '0625',
    totalMarks: 60,
    durationMinutes: 75,
    difficulty: 'medium',
    topics: ['Waves', 'Optics'],
    targetCount: 10,
    candidates: [candidate()],
  });
  assert.match(prompt, /Focus topics: Waves, Optics/);
});

test('the pool stays comfortably larger than the biggest paper allowed', () => {
  // If MAX_EXAM_ITEMS ever rises past the pool, the model would be asked to
  // pick more questions than it was shown.
  assert.ok(MAX_CANDIDATES >= MAX_EXAM_ITEMS * 2, `${MAX_CANDIDATES} vs ${MAX_EXAM_ITEMS}`);
});

test('the whole catalogue is far smaller than the JSON it replaces', () => {
  // Guards the actual point of the change. The old shape was JSON.stringify of
  // objects with 220-char previews; 30 formatted lines must stay well under
  // what 60 of those cost.
  const pool = Array.from({ length: MAX_CANDIDATES }, (_, index) =>
    candidate({ id: 1000 + index, content: 'The diagram shows an experiment. '.repeat(20) }),
  );
  const formatted = buildCandidateList(pool);
  const oldShape = JSON.stringify(
    Array.from({ length: 60 }, (_, index) => ({
      id: 1000 + index,
      year: 2024,
      session: 's',
      paperNumber: '21',
      number: 3,
      part: 'a',
      subPart: 'i',
      marks: 6,
      preview: 'The diagram shows an experiment. '.repeat(20).slice(0, 220),
    })),
  );
  assert.ok(formatted.length < oldShape.length / 3, `${formatted.length} vs ${oldShape.length}`);
});
