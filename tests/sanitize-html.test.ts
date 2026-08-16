import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * Regression tests for lib/sanitize-html.ts.
 *
 * The module is browser-only by design (it wraps DOMPurify and fails closed on
 * the server), so these tests stand up a minimal DOM first. Without a DOM the
 * sanitiser returns '' and every assertion below would pass vacuously — hence
 * the guard at the top.
 */

// Minimal DOM. jsdom isn't a dependency, so skip rather than silently pass.
let sanitizeHtml: (dirty: string | null | undefined) => string;
let hasDom = false;

try {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  ({ sanitizeHtml } = await import('../lib/sanitize-html.ts'));
  hasDom = true;
} catch {
  hasDom = false;
}

const maybe = hasDom ? test : test.skip;

maybe('strips script tags', () => {
  const out = sanitizeHtml('<p>hi</p><script>alert(1)</script>');
  assert.ok(!out.includes('<script'), out);
  assert.ok(out.includes('hi'), out);
});

maybe('strips inline event handlers', () => {
  const out = sanitizeHtml('<img src="x" onerror="alert(1)">');
  assert.ok(!/onerror/i.test(out), out);
});

maybe('strips javascript: hrefs but keeps https links', () => {
  assert.ok(!/javascript:/i.test(sanitizeHtml('<a href="javascript:alert(1)">x</a>')));

  const safe = sanitizeHtml('<a href="https://example.com">x</a>');
  assert.ok(safe.includes('https://example.com'), safe);
  // Links open in a new tab without leaking window.opener.
  assert.ok(safe.includes('noopener'), safe);
});

maybe('keeps the formatting TipTap and marked produce', () => {
  const out = sanitizeHtml(
    '<p><strong>bold</strong> <em>it</em> <code>x</code></p><ul><li>a</li></ul>',
  );
  for (const tag of ['<strong>', '<em>', '<code>', '<ul>', '<li>']) {
    assert.ok(out.includes(tag), `${tag} missing from ${out}`);
  }
});

maybe('drops dangerous css but keeps colour', () => {
  const out = sanitizeHtml('<span style="color: red; background: url(javascript:alert(1))">x</span>');
  assert.ok(out.includes('color'), out);
  assert.ok(!/url\(/i.test(out), out);
});

maybe('returns empty string for empty input', () => {
  assert.equal(sanitizeHtml(''), '');
  assert.equal(sanitizeHtml(null), '');
  assert.equal(sanitizeHtml(undefined), '');
});
