import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  analyticsSubjectName,
  bankSubjectCodesForNames,
  bankTopicName,
} from '../lib/bank-analytics.ts';

/**
 * Naming and mapping for the analytics surfaces.
 *
 * The weakness heatmap, the learning overview and the plan generator all read
 * two corpora now. If they disagree about what a subject is called, one
 * student's Biology splits into two rows and neither shows their real accuracy
 * -- which is the whole reason these live in one place.
 */

test('a bank subject aggregates under the same plain name the legacy corpus uses', () => {
  // "CAIE 0610" in the corpus, "Biology" everywhere a student can see.
  assert.equal(analyticsSubjectName({ name: 'CAIE 0610', code: '0610' }), 'Biology');
  assert.equal(analyticsSubjectName({ name: 'IB Physics', code: 'ib-physics' }), 'Physics');
});

test('a subject outside the catalogue keeps whatever the corpus stored', () => {
  assert.equal(analyticsSubjectName({ name: 'Sociology', code: '0495' }), 'Sociology');
});

test('the qualification is not appended, so one subject stays one row', () => {
  // bankSubjectName says "Biology (IGCSE)" for a paper browser. Here that
  // would split Biology in two, one row per corpus.
  assert.equal(analyticsSubjectName({ name: 'CAIE 0610', code: '0610' }), 'Biology');
});

test('display names map back to the codes the bank stores', () => {
  const codes = bankSubjectCodesForNames(['Biology']);
  assert.ok(codes.includes('0610'), `expected the IGCSE code, got ${codes.join(', ')}`);
  assert.ok(codes.includes('ib-biology'), `expected the IB slug, got ${codes.join(', ')}`);
  // The corpus carries some IB subjects with the prefix and some without.
  assert.ok(codes.includes('biology'), `expected the stripped slug, got ${codes.join(', ')}`);
});

test('an unknown subject name maps to no codes rather than to everything', () => {
  assert.deepEqual(bankSubjectCodesForNames(['Astrology']), []);
});

test('topics win over tags, and something is always returned', () => {
  assert.equal(
    bankTopicName({ topics: [{ topic: { name: 'Vectors' } }], tags: [{ tag: { label: 'dot-product' } }] }),
    'Vectors',
  );
  // bank_question_topics is empty across the corpus until the syllabus
  // registries land, so the tag fallback is what actually runs today.
  assert.equal(bankTopicName({ topics: [], tags: [{ tag: { label: 'dot-product' } }] }), 'dot-product');
  assert.equal(bankTopicName({ topics: [], tags: [] }), 'General');
});
