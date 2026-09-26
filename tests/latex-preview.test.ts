import { test } from 'node:test';
import assert from 'node:assert/strict';

import { plainTextPreview } from '../lib/latex.ts';

/**
 * Previews are line-clamped text in a card. KaTeX never runs on them, so
 * whatever survives here is literally what the student reads.
 *
 * These three strings are real content from the Study page's focus queue on
 * 27 Sep 2026, where they rendered as markup: `\begin{array}{c}`,
 * `\text{energy}`, `\uparrow` and a bare `\rightarrow` sitting in prose with
 * no `$` around it.
 */

test('array scaffolding is dropped and its words kept', () => {
  const out = plainTextPreview(
    'A diagram is shown. \\begin{array}{c} \\text{energy} \\\\ \\uparrow \\\\ \\text{reactants} \\end{array}');
  assert.match(out, /A diagram is shown\. energy ↑ reactants/);
  assert.doesNotMatch(out, /\\begin|\\text|\\uparrow|[{}]/);
});

test('a bare reaction arrow outside math delimiters is still translated', () => {
  const out = plainTextPreview('CuCO3(s) + H2SO4(aq) \\rightarrow CuSO4(aq) + CO2(g)');
  assert.equal(out, 'CuCO3(s) + H2SO4(aq) → CuSO4(aq) + CO2(g)');
});

test('delimited math loses its dollars and its commands', () => {
  assert.equal(plainTextPreview('Solve $\\frac{x}{3} \\le 5$ for $x$.'), 'Solve x/3 ≤ 5 for x.');
});

test('markdown emphasis is still stripped', () => {
  assert.equal(plainTextPreview('**Bold** and `code`'), 'Bold and code');
});

test('an untranslated command keeps its word rather than a backslash', () => {
  // Better to read "upharpoonright" than "\upharpoonright"; neither is good,
  // but only one looks like a bug.
  assert.equal(plainTextPreview('a \\upharpoonright b'), 'a upharpoonright b');
});

test('plain prose is returned unchanged', () => {
  assert.equal(plainTextPreview('Describe how osmosis moves water.'),
    'Describe how osmosis moves water.');
});
