import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFile(join(ROOT, p), 'utf8');

/**
 * The competition vault is an easter egg holding 1,398 real STEP questions.
 * The decision was to keep it rather than delete the key listener, which makes
 * these three properties the price of keeping it.
 */

test('the unlock endpoint is rate limited per account', async () => {
  const route = await read('app/api/unlock/route.ts');
  assert.match(route, /unlockLimiter/, 'route must consult a limiter');
  assert.match(
    route,
    /unlockLimiter\.check\(`unlock:\$\{user\.id\}`\)/,
    'the limiter must be keyed to the account, not the IP: a year group shares one egress address',
  );
  assert.match(route, /status:\s*429/, 'a throttled attempt must say so');
});

test('the pass-phrase is not compared with ===', async () => {
  const route = await read('app/api/unlock/route.ts');
  assert.doesNotMatch(
    route,
    /parsed\.passphrase\s*===\s*(process\.env\.)?COMPETITION_PASSPHRASE/,
    'a plain === on the secret leaks it through timing',
  );
  assert.match(route, /timingSafeEqual/);
});

test('hashing both sides makes the comparison length-blind', () => {
  // The reason secretEquals hashes first: timingSafeEqual throws on unequal
  // lengths, and that throw would itself tell an attacker the secret's length.
  const eq = (a: string, b: string) =>
    timingSafeEqual(
      createHash('sha256').update(a, 'utf8').digest(),
      createHash('sha256').update(b, 'utf8').digest(),
    );
  assert.equal(eq('correct horse', 'correct horse'), true);
  assert.equal(eq('x', 'a much longer guess entirely'), false, 'must compare, not throw');
  assert.equal(eq('', 'nonempty'), false);
});

test('an unset COMPETITION_PASSPHRASE cannot be matched', async () => {
  const route = await read('app/api/unlock/route.ts');
  // Without the `configured &&` guard an empty env var would make every empty
  // pass-phrase succeed, which is the classic way this kind of gate opens up.
  assert.match(route, /configured\s*&&\s*secretEquals/);
});

test('the Konami listener ignores keystrokes aimed at a field', async () => {
  const widget = await read('app/components/UnlockWidget.tsx');
  assert.match(widget, /isEditable/, 'must test the event target');
  assert.match(widget, /isContentEditable/, 'the notes editor is contenteditable, not a textarea');
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.match(widget, new RegExp(`'${tag}'`), `must exclude <${tag.toLowerCase()}>`);
  }
});

test('typing into a field clears the buffer rather than merely skipping it', async () => {
  const widget = await read('app/components/UnlockWidget.tsx');
  // Skipping alone would let "↑↑↓↓←→←→" survive in the buffer across a trip
  // into an answer box, so a later stray "ba" would still fire.
  assert.match(
    widget,
    /if \(isEditable\(e\.target\)\) \{\s*konamiBuffer\.current = \[\];\s*return;/,
    'the buffer must be reset when focus is in a field',
  );
});

test('the vault gates on the unlock, and the gate is server-side', async () => {
  const step = await read('app/api/step/route.ts');
  assert.match(step, /getSessionUser/, 'must require a session');
  assert.match(step, /unlocks\s*\?\?\s*\[\]\)\.includes\(COMPETITION_KEY\)/);
});
