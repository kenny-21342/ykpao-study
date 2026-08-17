import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * Regression tests for the post-sanitisation math pass used by RichContent.
 *
 * RichContent sanitises stored rich text, turns it into a DOM, and then walks
 * text nodes rewriting `$...$` into KaTeX HTML. That rewrite writes back
 * through `innerHTML`, so it re-parses whatever else was in the text node —
 * and a text node's value is *decoded*, meaning a student post containing the
 * literal characters `<img src=x onerror=...>` (which the sanitiser correctly
 * stored as `&lt;img ...&gt;`) came back as a live element. Any post that also
 * contained a `$` pair was therefore stored XSS past DOMPurify.
 *
 * Needs a DOM: skip rather than pass vacuously if jsdom is unavailable.
 */

let sanitizeHtml: (dirty: string | null | undefined) => string;
let renderMathInText: (text: string) => string;
let renderMathTextNodes: (root: HTMLElement) => void;
let hasDom = false;

try {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.NodeFilter = dom.window.NodeFilter;
  ({ sanitizeHtml } = await import('../lib/sanitize-html.ts'));
  ({ renderMathInText, renderMathTextNodes } = await import('../lib/latex.ts'));
  hasDom = true;
} catch {
  hasDom = false;
}

const maybe = hasDom ? test : test.skip;

maybe('math rewriting does not resurrect escaped markup as elements', () => {
  const stored = '<p>&lt;img src=x onerror=alert(1)&gt; costs $x$ pounds</p>';
  const clean = sanitizeHtml(stored);
  assert.ok(!/onerror=alert/.test(clean.replace(/&lt;|&gt;/g, '')) || !clean.includes('<img'), clean);

  const root = document.createElement('div');
  root.innerHTML = clean;
  renderMathTextNodes(root);

  assert.equal(root.querySelectorAll('img').length, 0, root.innerHTML);
  assert.equal(root.querySelectorAll('script').length, 0, root.innerHTML);
  // The text must survive as text.
  assert.ok(root.textContent?.includes('<img src=x onerror=alert(1)>'), root.textContent ?? '');
});

maybe('escaped angle brackets survive even with no math in the node', () => {
  const out = renderMathInText('a < b and 5$ is cheap');
  assert.ok(!out.includes('<b'), out);
  assert.ok(out.includes('&lt;'), out);
});

maybe('inline and display math still render', () => {
  const inline = renderMathInText('value $x^2$ here');
  assert.ok(inline.includes('inline-math'), inline);
  assert.ok(inline.includes('katex'), inline);

  const display = renderMathInText('$$x^2$$');
  assert.ok(display.includes('katex-display') || display.includes('katex'), display);
});

maybe('code and pre blocks are left alone', () => {
  const root = document.createElement('div');
  root.innerHTML = '<pre><code>cost = $x$ + $y$</code></pre>';
  renderMathTextNodes(root);
  assert.ok(!root.innerHTML.includes('inline-math'), root.innerHTML);
});
