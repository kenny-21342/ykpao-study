import { test } from 'node:test';
import assert from 'node:assert/strict';

import { passageMatchesQuery, requiredTermMatches, searchTerms } from '../lib/rag-terms.ts';

const question =
  'Check for understanding: a non-uniform rod of the same weight and length is pivoted at one end, and the support at 4.00 m now reads 27.0 N. How far from the pivot is its centre of mass?';

test('how many terms a passage needs scales with the query', () => {
  assert.equal(requiredTermMatches(0), 0);
  assert.equal(requiredTermMatches(1), 1);
  assert.equal(requiredTermMatches(2), 1);
  assert.equal(requiredTermMatches(4), 2);
  assert.equal(requiredTermMatches(6), 3);
});

test('unrelated questions that share one word are not evidence', () => {
  const terms = searchTerms(question);
  assert.ok(terms.length >= 4);
  const cs = 'Audrey wants to send a sound file to Nico using email. The file is too large to attach so she decides to compress the file. She uses lossless compression and a pivot table.';
  const economics = "Why do economists draw a distinction between economic development and economic growth? because a country's stage of weight depends";
  assert.equal(passageMatchesQuery(cs, terms), false);
  assert.equal(passageMatchesQuery(economics, terms), false);
});

test('a genuinely related passage still matches', () => {
  const terms = searchTerms(question);
  const physics = 'A non-uniform rod of weight 36.0 N is pivoted at one end. Find the centre of mass of the rod using the principle of moments about the pivot.';
  assert.equal(passageMatchesQuery(physics, terms), true);
});

test('prefix matching mirrors the index (plural and stem forms)', () => {
  assert.equal(passageMatchesQuery('Calculating moments about the pivots', ['moment', 'pivot']), true);
});
