import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTextAudit } from '../lib/text-audit.ts';

test('a clean verdict', () => {
  assert.deepEqual(parseTextAudit('{"severity":"none","issues":[]}'), { level: 'clean', issues: [] });
});

test('JSON wrapped in prose or a code fence is still read', () => {
  const reply = 'Here you go:\n```json\n{"severity":"major","issues":["Part (b) is missing."]}\n```';
  assert.deepEqual(parseTextAudit(reply), { level: 'major', issues: ['Part (b) is missing.'] });
});

test('an unknown severity or unreadable reply is never treated as clean', () => {
  assert.equal(parseTextAudit('{"severity":"fine","issues":[]}'), null);
  assert.equal(parseTextAudit('looks good to me'), null);
  assert.equal(parseTextAudit('{"severity": '), null);
  assert.equal(parseTextAudit(''), null);
});

test('non-string issues are ignored', () => {
  assert.deepEqual(parseTextAudit('{"severity":"minor","issues":["a",3,null," b "]}'), { level: 'minor', issues: ['a', 'b'] });
});
