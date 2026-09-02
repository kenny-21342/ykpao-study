import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseGradeBoundaryCsv } from '../lib/grade-boundary-import.ts';

/**
 * Ingesting grade thresholds.
 *
 * These decide what a student is told their grade is, so the parser refuses
 * anything it cannot read rather than guessing. A silently-wrong threshold is
 * worse than a rejected upload: it produces a confident grade that is wrong,
 * and a student may act on it.
 */

const header = 'board,subjectCode,level,year,session,paperNumber,grade,minMark,totalMarks';

test('a well-formed CAIE table is read', () => {
  const { rows, errors } = parseGradeBoundaryCsv(
    `${header}\nCAIE,0610,igcse,2025,s,2,A,58,80\nCAIE,0610,igcse,2025,s,2,B,50,80`,
    'published',
  );
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].subjectCode, '0610');
  assert.equal(rows[0].minMark, 58);
  assert.equal(rows[0].source, 'published');
});

test('the uploader cannot label their own figures as published', () => {
  // `source` comes from the caller, never from the file.
  const csv = `${header},source\nIB,ib-biology,HL,2025,May,1,7,72,90`;
  const { rows } = parseGradeBoundaryCsv(csv, 'school');
  assert.equal(rows[0].source, 'school');
});

test('a letter grade filed against an IB subject is rejected, not stored', () => {
  // Stored, it would be ignored at lookup and the student would silently get a
  // fallback estimate with nothing to say the upload was wrong.
  const { rows, errors } = parseGradeBoundaryCsv(
    `${header}\nIB,ib-biology,HL,2025,May,1,A,72,90`,
    'school',
  );
  assert.equal(rows.length, 0);
  assert.match(errors[0], /not a IB grade/);
});

test('an IB 1-7 grade is accepted', () => {
  const { rows, errors } = parseGradeBoundaryCsv(
    `${header}\nIB,ib-biology,HL,2025,May,1,7,72,90`,
    'school',
  );
  assert.deepEqual(errors, []);
  assert.equal(rows[0].grade, '7');
});

test('thresholds that run the wrong way are reported', () => {
  // A transcription slip that would otherwise award the wrong grade in silence.
  const { errors } = parseGradeBoundaryCsv(
    `${header}\nCAIE,0610,igcse,2025,s,2,A,40,80\nCAIE,0610,igcse,2025,s,2,B,60,80`,
    'published',
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /wrong way round/);
});

test('a mark above the paper total is refused', () => {
  const { rows, errors } = parseGradeBoundaryCsv(
    `${header}\nCAIE,0610,igcse,2025,s,2,A,90,80`,
    'published',
  );
  assert.equal(rows.length, 0);
  assert.match(errors[0], /above totalMarks/);
});

test('a missing required column fails the whole file rather than half of it', () => {
  const { rows, errors } = parseGradeBoundaryCsv('board,subjectCode\nCAIE,0610', 'published');
  assert.equal(rows.length, 0);
  assert.match(errors[0], /Missing required column/);
});

test('one bad row does not discard the good ones', () => {
  const { rows, errors } = parseGradeBoundaryCsv(
    `${header}\nCAIE,0610,igcse,2025,s,2,A,58,80\nCAIE,0610,igcse,2025,s,2,Z,50,80`,
    'published',
  );
  assert.equal(rows.length, 1);
  assert.equal(errors.length, 1);
});

test('columns may be in any order, and quoted cells are handled', () => {
  const { rows, errors } = parseGradeBoundaryCsv(
    'grade,minMark,board,totalMarks,subjectCode\n"A",58,"CAIE",80,"0610"',
    'published',
  );
  assert.deepEqual(errors, []);
  assert.equal(rows[0].grade, 'A');
  assert.equal(rows[0].subjectCode, '0610');
});

test('an empty file is refused with a usable message', () => {
  const { errors } = parseGradeBoundaryCsv('', 'published');
  assert.match(errors[0], /header row/);
});
