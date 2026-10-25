import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_MEMORY, MEMORY_VERSION, memoryKey, parseMemory, serializeMemory,
  type PracticeFilterMemory,
} from '../lib/practice-filter-memory.ts';

const sample: PracticeFilterMemory = {
  ...EMPTY_MEMORY,
  scope: 'all', subject: '123', year: '2023', session: 'May', paperNumber: '1,2', variant: '1,3', timezone: 'TZ1,TZ0', levels: '4,5',
  topic: 'Circular motion', onlyBookmarked: true, hideDone: true, search: '22', page: 3,
  selectedId: 61174, scrollTop: 840,
};

test('what is written is exactly what is read back', () => {
  assert.deepEqual(parseMemory(serializeMemory(sample)), sample);
  assert.deepEqual(parseMemory(serializeMemory(EMPTY_MEMORY)), EMPTY_MEMORY);
});

test('the key is per user, so a second account in the tab does not inherit it', () => {
  assert.notEqual(memoryKey('user-a'), memoryKey('user-b'));
  assert.ok(memoryKey('user-a').includes('user-a'));
});

test('missing, empty or malformed input is "nothing remembered", never a throw', () => {
  for (const raw of [null, undefined, '', 'not json', '[]', 'null', '42', '"x"']) {
    assert.equal(parseMemory(raw as string | null | undefined), null, String(raw));
  }
});

test('a payload from another version is discarded rather than half-trusted', () => {
  const old = { ...sample, v: MEMORY_VERSION + 1 };
  assert.equal(parseMemory(JSON.stringify(old)), null);
  const { v: _dropped, ...noVersion } = sample;
  assert.equal(parseMemory(JSON.stringify(noVersion)), null);
});

test('every field is validated; a tampered one rejects the whole payload', () => {
  const bad: Array<Record<string, unknown>> = [
    { scope: 'everything' },
    { subject: '12; DROP TABLE' },
    { subject: 'abc' },
    { year: '20233' },
    { paperNumber: '1.5' },
    { paperNumber: '1,,2' },
    { variant: '1;2' },
    { timezone: 'TZ9' },
    { levels: '6' },
    { session: 'x'.repeat(40) },
    { topic: 'x'.repeat(201) },
    { search: 'x'.repeat(201) },
    { onlyBookmarked: 'yes' },
    { page: 0 },
    { page: 1.5 },
    { page: 1e9 },
    { page: '3' },
    { selectedId: 0 },
    { selectedId: -4 },
    { selectedId: '61174' },
    { scrollTop: -1 },
    { scrollTop: Number.POSITIVE_INFINITY },
    { scrollTop: '10' },
  ];
  for (const patch of bad) {
    assert.equal(parseMemory(JSON.stringify({ ...sample, ...patch })), null, JSON.stringify(patch));
  }
});

test('an oversized payload is rejected before it is even parsed', () => {
  const huge = JSON.stringify({ ...sample, topic: 'x'.repeat(5000) });
  assert.equal(parseMemory(huge), null);
});

test('no question open and no scroll is a valid, ordinary state', () => {
  const parsed = parseMemory(serializeMemory({ ...sample, selectedId: null, scrollTop: 0 }));
  assert.equal(parsed?.selectedId, null);
  assert.equal(parsed?.scrollTop, 0);
});

test('a payload saved before the hide-done toggle still restores, with it off', () => {
  const { hideDone: _omitted, ...old } = JSON.parse(serializeMemory(sample));
  assert.equal(parseMemory(JSON.stringify(old))?.hideDone, false);
  assert.equal(parseMemory(JSON.stringify({ ...old, hideDone: 'yes' })), null);
});
