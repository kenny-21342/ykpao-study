import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHintPrompt, cleanPreviousHints, LEVEL_RULES, MAX_PREVIOUS_HINTS, MAX_PREVIOUS_HINT_CHARS,
} from '../lib/hint-prompt.ts';

const base = { subject: 'Physics', question: 'A mass moves in a horizontal circle.', level: 1 };

test('the first hint carries no history block', () => {
  const prompt = buildHintPrompt(base);
  assert.doesNotMatch(prompt, /already given/i);
  assert.match(prompt, /Hint level 1 of 3/);
  assert.ok(prompt.includes(LEVEL_RULES[1]));
});

test('later hints are shown the earlier ones and told not to restate them', () => {
  // The reported bug: Hint 2 and Hint 3 opened with the same sentence as Hint 1
  // because the request never said what had already been given.
  const prompt = buildHintPrompt({
    ...base, level: 3,
    previousHints: ['Think about the forces on the mass.', 'Resolve the tension vertically.'],
  });
  assert.match(prompt, /already given/i);
  assert.match(prompt, /do not restate or reword/i);
  assert.ok(prompt.includes('Hint 1: Think about the forces on the mass.'));
  assert.ok(prompt.includes('Hint 2: Resolve the tension vertically.'));
  assert.match(prompt, /Hint level 3 of 3/);
});

test('history is trimmed, emptied entries dropped and only the latest kept', () => {
  assert.deepEqual(cleanPreviousHints(['  a  ', '', '   ', 'b', 'c']), ['b', 'c']);
  assert.equal(cleanPreviousHints(undefined).length, 0);
  assert.ok(cleanPreviousHints(['x', 'y', 'z', 'w']).length <= MAX_PREVIOUS_HINTS);
});

test('an oversized earlier hint is cut rather than passed through whole', () => {
  const [kept] = cleanPreviousHints(['q'.repeat(MAX_PREVIOUS_HINT_CHARS + 500)]);
  assert.equal(kept.length, MAX_PREVIOUS_HINT_CHARS);
});

test('a missing mark scheme is stated, and a student answer is included when given', () => {
  const none = buildHintPrompt({ ...base, reference: '   ' });
  assert.match(none, /No mark scheme was found\./);
  const withAnswer = buildHintPrompt({ ...base, studentAnswer: 'T = mg' });
  assert.ok(withAnswer.includes("Student's current answer:\nT = mg"));
});

test('an invalid level fails loudly instead of building a prompt with no rule', () => {
  assert.throws(() => buildHintPrompt({ ...base, level: 4 }), /Hint level/);
});
