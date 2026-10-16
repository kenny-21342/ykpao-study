import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  paperClauses, parseIntList, parseZoneList, questionClauses,
} from '../lib/bank-filter-clauses.ts';

test('no filters produce no clauses', () => {
  assert.deepEqual(paperClauses({}), {});
  assert.deepEqual(questionClauses({}), []);
});

test('paper, variant and time zone are multi-select', () => {
  assert.deepEqual(paperClauses({ paperNumbers: [1, 2], variants: [3] }), {
    paperNumber: { in: [1, 2] }, variant: { in: [3] },
  });
});

test('TZ0 means no time zone and can be combined with real zones', () => {
  assert.deepEqual(paperClauses({ timezones: ['TZ1', 'TZ0'] }), {
    AND: [{ OR: [{ timezone: { in: ['TZ1'] } }, { timezone: null }] }],
  });
  assert.deepEqual(paperClauses({ timezones: ['TZ0'] }), { AND: [{ OR: [{ timezone: null }] }] });
});

test('a topic matches the question or any of its parts', () => {
  const [clause] = questionClauses({ topic: 'Mechanics' });
  assert.deepEqual(clause, {
    OR: [
      { topics: { some: { topic: { name: 'Mechanics' } } } },
      { partRows: { some: { topic: 'Mechanics' } } },
    ],
  });
});

test('a level matches any part, or the question itself when it has no parts', () => {
  const [clause] = questionClauses({ levels: [4, 5] });
  assert.deepEqual(clause, {
    OR: [
      { partRows: { some: { difficulty: { in: [4, 5] } } } },
      { AND: [{ partRows: { none: {} } }, { difficulty: { in: [4, 5] } }] },
    ],
  });
});

test('list parsing drops junk, duplicates and out-of-range values', () => {
  assert.deepEqual(parseIntList('1,2,2,x,300,3'), [1, 2, 3]);
  assert.deepEqual(parseIntList('0,6,3', 10, 1, 5), [3]);
  assert.deepEqual(parseIntList(''), []);
  assert.deepEqual(parseIntList('1,2,3,4,5', 2), [1, 2]);
  assert.deepEqual(parseZoneList('tz1, TZ2,TZ9,bad,TZ1'), ['TZ1', 'TZ2']);
});
