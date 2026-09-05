import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  curriculumLabel,
  docTypeLabel,
  documentLabel,
  groupIntoInstances,
  instanceLabel,
  parseCurriculumId,
  sessionLabel,
  sessionOrder,
} from '../lib/paper-catalogue.ts';

type Row = Parameters<typeof groupIntoInstances>[0][number];

function row(overrides: Partial<Row> & { id: number; docType: string }): Row {
  return {
    year: 2023,
    session: 's',
    paperNumber: 4,
    paperCode: '42',
    variant: 2,
    level: '',
    timezone: '',
    filename: `paper-${overrides.id}.pdf`,
    pageCount: 12,
    sizeBytes: 1024,
    subject: { code: '0625', name: 'Physics' },
    ...overrides,
  };
}

test('a question paper and its mark scheme collapse into one sitting', () => {
  const instances = groupIntoInstances([
    row({ id: 1, docType: 'qp' }),
    row({ id: 2, docType: 'ms' }),
  ]);

  assert.equal(instances.length, 1);
  assert.deepEqual(
    instances[0].documents.map((d) => d.docType),
    ['qp', 'ms'],
  );
});

test('documents are ordered paper first, then mark scheme, then extras', () => {
  const instances = groupIntoInstances([
    row({ id: 1, docType: 'in' }),
    row({ id: 2, docType: 'ms' }),
    row({ id: 3, docType: 'qp' }),
  ]);

  assert.deepEqual(
    instances[0].documents.map((d) => d.docType),
    ['qp', 'ms', 'in'],
  );
});

test('different variants are different sittings', () => {
  const instances = groupIntoInstances([
    row({ id: 1, docType: 'qp', variant: 1, paperCode: '41' }),
    row({ id: 2, docType: 'qp', variant: 2, paperCode: '42' }),
  ]);

  assert.equal(instances.length, 2);
  assert.deepEqual(
    instances.map((i) => i.variant),
    [1, 2],
  );
});

test('IB HL and SL are separate sittings, not documents of one', () => {
  const base = { docType: 'qp', session: 'may', paperCode: '1', paperNumber: 1, timezone: 'TZ1' };
  const instances = groupIntoInstances([
    row({ id: 1, ...base, level: 'HL' }),
    row({ id: 2, ...base, level: 'SL' }),
  ]);

  assert.equal(instances.length, 2);
});

test('IB timezones are separate sittings', () => {
  const base = { docType: 'qp', session: 'may', paperCode: '1', paperNumber: 1, level: 'HL' };
  const instances = groupIntoInstances([
    row({ id: 1, ...base, timezone: 'TZ1' }),
    row({ id: 2, ...base, timezone: 'TZ2' }),
  ]);

  assert.equal(instances.length, 2);
});

test('a mark scheme is matched to its own timezone, not another', () => {
  const base = { session: 'may', paperCode: '1', paperNumber: 1, level: 'HL' };
  const instances = groupIntoInstances([
    row({ id: 1, ...base, timezone: 'TZ1', docType: 'qp' }),
    row({ id: 2, ...base, timezone: 'TZ2', docType: 'qp' }),
    row({ id: 3, ...base, timezone: 'TZ2', docType: 'ms' }),
  ]);

  const tz2 = instances.find((i) => i.timezone === 'TZ2');
  const tz1 = instances.find((i) => i.timezone === 'TZ1');
  assert.deepEqual(tz2?.documents.map((d) => d.id), [2, 3]);
  assert.deepEqual(tz1?.documents.map((d) => d.id), [1]);
});

test('sittings are ordered by paper then variant', () => {
  const instances = groupIntoInstances([
    row({ id: 1, docType: 'qp', paperNumber: 4, variant: 2, paperCode: '42' }),
    row({ id: 2, docType: 'qp', paperNumber: 1, variant: 1, paperCode: '11' }),
    row({ id: 3, docType: 'qp', paperNumber: 1, variant: 3, paperCode: '13' }),
  ]);

  assert.deepEqual(
    instances.map((i) => `${i.paperNumber}${i.variant}`),
    ['11', '13', '42'],
  );
});

test('CAIE labels use the paper number, not the two-digit component', () => {
  // paperCode "42" means Paper 4 Variant 2 and must not read as "Paper 42".
  assert.equal(
    instanceLabel({ paperNumber: 4, paperCode: '42', variant: 2, level: '', timezone: '' }),
    'Paper 4 · Variant 2',
  );
});

test('IB labels keep a lettered paper code and add timezone and level', () => {
  assert.equal(
    instanceLabel({ paperNumber: 1, paperCode: '1A', variant: 0, level: 'HL', timezone: 'TZ1' }),
    'Paper 1A · TZ1 · HL',
  );
});

test('session labels and chronological ordering', () => {
  assert.equal(sessionLabel('s'), 'May/June');
  assert.equal(sessionLabel('w'), 'Oct/Nov');
  assert.equal(sessionLabel('m'), 'Feb/March');
  assert.equal(sessionLabel('nov'), 'November');
  assert.ok(sessionOrder('m') < sessionOrder('s'));
  assert.ok(sessionOrder('s') < sessionOrder('w'));
  assert.ok(sessionOrder('may') < sessionOrder('nov'));
});

test('document type labels', () => {
  assert.equal(docTypeLabel('qp'), 'Question Paper');
  assert.equal(docTypeLabel('ms'), 'Mark Scheme');
  assert.equal(docTypeLabel('cs'), 'Case Study');
});

test('curriculum ids round-trip', () => {
  assert.deepEqual(parseCurriculumId('CAIE|IGCSE'), { board: 'CAIE', qualification: 'IGCSE' });
  assert.equal(curriculumLabel('CAIE', 'IGCSE'), 'Cambridge IGCSE');
  assert.equal(curriculumLabel('IB', 'Diploma Programme'), 'IB Diploma Programme');
});

/*
 * Listening audio.
 *
 * A Music sitting carries four mp3 tracks, all typed `au`. They have to stay in
 * the sitting they belong to and stay distinguishable from one another; a
 * tester found the audio missing entirely, and four controls all reading
 * "Audio" would be the next version of the same complaint.
 */

test('audio tracks join their sitting rather than splitting it', () => {
  const instances = groupIntoInstances([
    row({ id: 1, docType: 'ms', filename: 'Music___HLSL_markscheme.pdf', level: 'HLSL' }),
    row({ id: 2, docType: 'au', filename: 'Track 1.mp3', level: 'HLSL', pageCount: null }),
    row({ id: 3, docType: 'au', filename: 'Track 2.mp3', level: 'HLSL', pageCount: null }),
  ]);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].documents.length, 3);
});

test('audio is offered before the mark scheme', () => {
  const instances = groupIntoInstances([
    row({ id: 1, docType: 'ms' }),
    row({ id: 2, docType: 'au', filename: 'Track 1.mp3' }),
    row({ id: 3, docType: 'qp' }),
  ]);
  assert.deepEqual(instances[0].documents.map((document) => document.docType), ['qp', 'au', 'ms']);
});

test('each track is labelled by its number, not by its type', () => {
  assert.equal(documentLabel({ docType: 'au', filename: 'Track 3.mp3' }), 'Track 3');
  assert.equal(documentLabel({ docType: 'au', filename: 'Track 12.mp3' }), 'Track 12');
});

test('a document that is not audio keeps its type label', () => {
  assert.equal(documentLabel({ docType: 'ms', filename: 'Track 3.mp3' }), 'Mark Scheme');
  assert.equal(documentLabel({ docType: 'qp', filename: '9709_s20_qp_52.pdf' }), 'Question Paper');
});

test('an unnumbered track falls back to the type label rather than showing nothing', () => {
  assert.equal(documentLabel({ docType: 'au', filename: 'listening.mp3' }), 'Audio');
});
