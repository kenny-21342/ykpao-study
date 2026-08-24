import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_INT4, parseEntityId, parsePagination, parsePositiveInt } from '../lib/query-params.ts';

test('non-numeric input falls back instead of producing NaN', () => {
  // The bug this guards against: Math.max(1, parseInt('abc', 10)) is NaN,
  // which used to reach Prisma's skip/take and the raw SQL in /api/step.
  assert.equal(parsePositiveInt('abc', 20), 20);
  assert.equal(parsePositiveInt('', 20), 20);
  assert.equal(parsePositiveInt(null, 20), 20);
  assert.equal(parsePositiveInt(undefined, 20), 20);
  assert.equal(parsePositiveInt('12abc', 20), 12); // parseInt's prefix behaviour
});

test('zero and negative values fall back', () => {
  assert.equal(parsePositiveInt('0', 20), 20);
  assert.equal(parsePositiveInt('-5', 20), 20);
});

test('values are clamped to max when one is given', () => {
  assert.equal(parsePositiveInt('999999', 20, 100), 100);
  assert.equal(parsePositiveInt('50', 20, 100), 50);
  assert.equal(parsePositiveInt('999999', 20), 999999, 'no max means no clamp');
});

test('every result is a finite integer', () => {
  for (const raw of ['abc', '', '-1', '0', 'NaN', 'Infinity', '1e5', '  7  ']) {
    const value = parsePositiveInt(raw, 20, 100);
    assert.ok(Number.isInteger(value), `${raw} produced ${value}`);
    assert.ok(value >= 1 && value <= 100, `${raw} produced out-of-range ${value}`);
  }
});

test('parsePagination derives a correct skip', () => {
  const params = new URLSearchParams({ page: '3', limit: '20' });
  assert.deepEqual(parsePagination(params), { page: 3, limit: 20, skip: 40 });
});

test('parsePagination caps limit and never yields a negative skip', () => {
  const params = new URLSearchParams({ page: 'abc', limit: '100000' });
  const { page, limit, skip } = parsePagination(params, { maxLimit: 50 });
  assert.equal(page, 1);
  assert.equal(limit, 50);
  assert.equal(skip, 0);
});

// ---------------------------------------------------------------------------
// Out-of-range integers. `?page=99999999999999999999` parses to a finite 1e20,
// passes every Number.isFinite check, and then fails inside Prisma — a 500 on
// input anyone can type into the address bar.
// ---------------------------------------------------------------------------

test('a huge page number is clamped, not passed through', () => {
  assert.equal(parsePositiveInt('99999999999999999999', 1), MAX_INT4);
  assert.equal(parsePositiveInt(String(MAX_INT4 + 1), 1), MAX_INT4);
});

test('skip stays inside int4 even at the largest page', () => {
  const params = new URLSearchParams({ page: '99999999999999999999', limit: '20' });
  const { skip, page } = parsePagination(params);
  assert.ok(skip <= MAX_INT4, `skip ${skip} exceeds int4`);
  assert.ok(page >= 1);
});

test('parseEntityId rejects what the column cannot hold', () => {
  assert.equal(parseEntityId('99999999999999999999'), null);
  assert.equal(parseEntityId(String(MAX_INT4 + 1)), null);
  assert.equal(parseEntityId('0'), null);
  assert.equal(parseEntityId('-3'), null);
  assert.equal(parseEntityId('abc'), null);
  assert.equal(parseEntityId(null), null);
  // And still accepts a real id.
  assert.equal(parseEntityId('2576'), 2576);
  assert.equal(parseEntityId(String(MAX_INT4)), MAX_INT4);
});
