import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonReply } from '../../lib/ai';

test('a stray closing bracket after a long string is mended, not fatal', () => {
  // The shape a real grader reply took: the explanation string closed with an
  // array bracket that was never opened, before the model answer.
  const raw = '{"score":18,"weaknesses":["thin evaluation"],"explanation":"Weigh it, then judge."],"modelAnswer":"### (a) Inequality ..."}';
  const parsed = parseJsonReply<{ score: number; modelAnswer: string }>(raw);
  assert.equal(parsed.score, 18);
  assert.match(parsed.modelAnswer, /Inequality/);
});

test('a bracket inside a string is left alone', () => {
  const parsed = parseJsonReply<{ a: string }>('{"a":"use [brackets] and } braces"}');
  assert.equal(parsed.a, 'use [brackets] and } braces');
});

test('a truncated reply still fails', () => {
  assert.throws(() => parseJsonReply('{"score":3,"modelAnswer":"cut off mid'));
});
