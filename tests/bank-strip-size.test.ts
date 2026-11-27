import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stripDisplaySize } from '../lib/bank-strip-size.ts';

test('a strip rendered below 200 DPI is laid out at its size on the page', () => {
  // Question 52258: the same 534pt column at 147 and at 200 DPI.
  assert.deepEqual(stripDisplaySize({ width: 1095, height: 300, sourceDpi: 147 }), { width: 1490, height: 408 });
  assert.deepEqual(stripDisplaySize({ width: 1485, height: 900, sourceDpi: 200 }), { width: 1485, height: 900 });
});

test('a missing DPI or dimension is left alone', () => {
  assert.deepEqual(stripDisplaySize({ width: 800, height: null }), { width: 800, height: null });
  assert.deepEqual(stripDisplaySize({ width: null, height: 10, sourceDpi: 0 }), { width: null, height: 10 });
});
