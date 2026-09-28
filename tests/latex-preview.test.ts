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

test('spacing commands vanish rather than leaving their name behind', () => {
  // `\quad` is horizontal space. The keep-the-word fallback turned it into
  // "quad", which shipped and read as a typo in the focus queue.
  assert.equal(plainTextPreview('energy \\uparrow reactants \\quad products'),
    'energy ↑ reactants products');
});

test('a figure placeholder does not reach the reader', () => {
  /**
   * Taken verbatim from the first search result for "measuring cylinder to
   * measure the volume" on production, 28 Sep 2026. Every transcribed question
   * with a figure carried its `![](asset:fig1)` marker into the snippet,
   * because the snippet was built with `plainText`, which strips HTML tags and
   * knows nothing about Markdown.
   */
  assert.equal(
    plainTextPreview(
      'Fig. 1.1 shows a measuring cylinder containing some water. ![](asset:fig1) (a) State the volume.',
    ),
    'Fig. 1.1 shows a measuring cylinder containing some water. (a) State the volume.',
  );
});

test('a figure with alt text loses the markup too, not just the target', () => {
  assert.equal(
    plainTextPreview('before ![a ray diagram](asset:fig2) after'),
    'before after',
  );
});

test('a link keeps its words and drops its target', () => {
  // The words are the content; the URL is never something a preview shows.
  assert.equal(
    plainTextPreview('see [the mark scheme](https://example.com/ms.pdf) for detail'),
    'see the mark scheme for detail',
  );
});

test('square brackets that are not markup survive', () => {
  // Mark allocations are written exactly like this all over the corpus, and
  // eating them would make every snippet read as though marks were missing.
  assert.equal(
    plainTextPreview('State the volume. [1] Explain your answer. [3]'),
    'State the volume. [1] Explain your answer. [3]',
  );
});
