import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escapeStrayBackslashes } from '../lib/json-escapes.ts';

test('LaTeX with single backslashes becomes parseable, valid escapes untouched', () => {
  const raw = String.raw`{"explanation":"Use \(\Delta\lambda/\lambda = v/c\) so v \approx 0.009c.\nGood.","q":"say \"hi\"","u":"é \uZZ"}`;
  assert.throws(() => JSON.parse(raw));
  const parsed = JSON.parse(escapeStrayBackslashes(raw));
  assert.equal(parsed.explanation, String.raw`Use \(\Delta\lambda/\lambda = v/c\) so v \approx 0.009c.` + '\nGood.');
  assert.equal(parsed.q, 'say "hi"');
  assert.equal(parsed.u, String.raw`é \uZZ`);
});

test('text that already parses is unchanged', () => {
  const ok = '{"a":"line\\nnext \\\\frac","b":[1,2]}';
  assert.equal(escapeStrayBackslashes(ok), ok);
});
