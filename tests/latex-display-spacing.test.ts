import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdownWithMath } from '../lib/latex.ts';

/**
 * A display equation is a block element. The tutor writes blank lines around
 * each one; turning those into `<br/>`s left a hole above and below every
 * equation (reported from a phone, 21 Nov 2026).
 */
const source = [
  'Using the moment about the pivot:',
  '',
  '',
  '$$W \\times \\frac{L}{2} = 36.0 \\times 2.50 = 90 \\text{ N m}$$',
  '',
  '',
  'Why the support force comes out as it does',
  '',
  '$$F \\times 4.00 = 36.0 \\times 2.50 \\Rightarrow F = \\frac{90}{4.00} = 22.5\\ \\text{N}$$',
  '',
  'So F is 22.5 N.',
].join('\n');

test('no line breaks are stacked around a display equation', () => {
  const html = renderMarkdownWithMath(source);
  assert.equal((html.match(/katex-display/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<br\/>\s*<span class="katex-display"/);
  assert.doesNotMatch(html, /<\/span><\/span><br\/>/);
});

test('paragraph breaks around prose are kept', () => {
  const html = renderMarkdownWithMath('First.\n\nSecond.');
  assert.match(html, /First\.<br\/><br\/>Second\./);
});

test('inline math keeps its surrounding text and spaces', () => {
  const html = renderMarkdownWithMath('The force is $F = 22.5$ N here.');
  assert.match(html, /The force is <span class="katex">/);
  assert.match(html, / N here\./);
});
