import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const UI_DIR = path.join(ROOT, 'app/components/ui');

const read = (rel: string) => readFile(path.join(ROOT, rel), 'utf8');

/**
 * Comments mention the very block names these tests search for, so an
 * indexOf on the raw file finds the prose rather than the rule. Strip them
 * first, the way the other source-reading tests here do.
 */
const stripCssComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

async function uiSources(): Promise<Array<{ name: string; src: string }>> {
  const names = (await readdir(UI_DIR)).filter((f) => /\.tsx?$/.test(f));
  return Promise.all(
    names.map(async (name) => ({ name, src: await readFile(path.join(UI_DIR, name), 'utf8') })),
  );
}

// ---------------------------------------------------------------------------
// 1. The token layer switches with the theme
// ---------------------------------------------------------------------------

test('themed colours are declared in @theme inline, not a plain @theme', async () => {
  const css = stripCssComments(await read('app/globals.css'));

  const inlineBlock = css.slice(css.indexOf('@theme inline'), css.indexOf('@theme {'));
  assert.ok(inlineBlock.length > 0, 'expected both an @theme inline and a plain @theme block');

  // This is the failure that code review cannot see: a themed colour in a
  // plain `@theme` bakes today's value into the utility, so the class keeps
  // working, looks right in light mode, and silently stops switching in dark.
  for (const token of ['--color-surface', '--color-primary', '--color-line', '--color-accent']) {
    assert.match(
      inlineBlock,
      new RegExp(`${token}:\\s*var\\(`),
      `${token} must be in @theme inline and reference a var()`,
    );
  }

  // Every themed custom property needs a value under .dark, or that colour is
  // simply the light value on a dark page.
  const darkBlock = css.slice(css.indexOf('.dark {'), css.indexOf('@theme inline'));
  for (const prop of ['--surface', '--canvas', '--text-primary', '--border', '--accent']) {
    assert.match(darkBlock, new RegExp(`${prop}:`), `${prop} has no dark value`);
  }
});

// ---------------------------------------------------------------------------
// 2. The primitives hold the line the rest of the app is being moved onto
// ---------------------------------------------------------------------------

test('no primitive uses a gradient', async () => {
  for (const { name, src } of await uiSources()) {
    assert.doesNotMatch(src, /bg-gradient-to/, `${name} reintroduces a gradient`);
  }
});

test('the only shadow a primitive may use is shadow-overlay', async () => {
  for (const { name, src } of await uiSources()) {
    // Separation is by border and by the surface/canvas step. A drop shadow is
    // for things that genuinely float above the page, and those are handled by
    // the overlay token.
    assert.doesNotMatch(
      src,
      /\bshadow-(sm|md|lg|xl|2xl|inner)\b/,
      `${name} uses a sized shadow; use a border, or shadow-overlay if it floats`,
    );
  }
});

test('interactive primitives carry a visible focus state', async () => {
  const focusable = ['Button.tsx', 'Field.tsx', 'SegmentedControl.tsx'];
  for (const name of focusable) {
    const src = await readFile(path.join(UI_DIR, name), 'utf8');
    assert.match(src, /focus-visible:/, `${name} has no focus-visible style`);
  }
});

test('Button forwards arbitrary props so it can be given an accessible name', async () => {
  const src = await readFile(path.join(UI_DIR, 'Button.tsx'), 'utf8');
  // An icon-only button gets its name from aria-label. If `rest` were not
  // spread onto the element, that prop would be accepted and dropped — the
  // control would look correct in the source and be unlabelled in the DOM.
  assert.match(src, /\{\.\.\.rest\}/);
  // And it must not silently submit the form it happens to sit inside.
  assert.match(src, /type=\{type \?\? 'button'\}/);
});

test('Field wires the label, hint and error to the control', async () => {
  const src = await readFile(path.join(UI_DIR, 'Field.tsx'), 'utf8');
  assert.match(src, /useId\(\)/);
  assert.match(src, /htmlFor=\{id\}/);
  assert.match(src, /describedBy/);
  assert.match(src, /aria-invalid/);
});
