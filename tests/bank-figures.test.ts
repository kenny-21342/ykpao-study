import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withFigures } from '../lib/bank-figures.ts';

const sha = 'a'.repeat(64);

test('a figure placeholder becomes an image of that bank asset', () => {
  const html = withFigures('See ![](asset:fig1) below.', [{ placeholder: 'fig1', asset: { sha256: sha, width: 400, height: 300 } }]);
  assert.match(html, /<img src="\/bank_assets\/aa\/a{64}\.png" alt="Figure" width="400" height="300"/);
  assert.doesNotMatch(html, /asset:/);
});

test('a placeholder with no asset is dropped, not shown as markup', () => {
  assert.equal(withFigures('A ![](asset:fig9) B', []), 'A  B');
});

test('an asset whose digest is not a sha256 is never linked', () => {
  const html = withFigures('![](asset:fig1)', [{ placeholder: 'fig1', asset: { sha256: '../../etc/passwd', width: 1, height: 1 } }]);
  assert.equal(html, '');
});
