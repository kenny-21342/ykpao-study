import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * The toolbar's size dropdown calls setMark('textStyle', { fontSize }), but a
 * ProseMirror mark only keeps attributes its schema declares. TextStyle alone
 * declares none; Color adds `color`, and `FontSize` adds `fontSize`. FontSize
 * was never registered, so the chosen size was silently dropped before it
 * reached the document, the stored HTML, or any published post.
 *
 * Source-level because the extension list pulls in browser-only TipTap modules
 * that the bare node runner cannot import.
 */
test('the editor registers FontSize whenever the toolbar sets a font size', () => {
  const editor = readFileSync('app/components/RichTextEditor.tsx', 'utf8');
  const extensions = readFileSync('app/components/richTextEditorExtensions.ts', 'utf8');

  assert.match(editor, /setMark\('textStyle',\s*\{\s*fontSize/, 'the toolbar no longer sets a font size');
  assert.match(extensions, /import\s*\{[^}]*\bFontSize\b[^}]*\}\s*from\s*'@tiptap\/extension-text-style'/);
  assert.match(extensions, /^\s*FontSize,\s*$/m, 'FontSize is imported but not in the extension list');
});

test('the sanitiser keeps font-size, so a registered size survives to the posted view', () => {
  const sanitiser = readFileSync('lib/sanitize-html.ts', 'utf8');
  assert.match(sanitiser, /SAFE_STYLE_PROPS[\s\S]*?'font-size'/);
});

test('the read-only view shares the editor rules rather than copying them', () => {
  const css = readFileSync('app/styles/editor.css', 'utf8');
  for (const rule of ['a', 'ul', 'ol', 'h1', 'blockquote', 'code', 'table']) {
    assert.match(css, new RegExp(`\\.rich-content ${rule}\\b`), `.rich-content ${rule} is not styled`);
  }
  const rich = readFileSync('app/components/RichContent.tsx', 'utf8');
  assert.match(rich, /'rich-content'/);
});
