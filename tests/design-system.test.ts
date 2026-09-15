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

/** Every .tsx/.ts under app/, matching the walker in dialogs.test.ts. */
async function appSources(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        await walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  }
  await walk(path.join(ROOT, 'app'));
  return out;
}

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

// ---------------------------------------------------------------------------
// 7. The radius scale stays collapsed
// ---------------------------------------------------------------------------

test('only three radii are in use, and the aliases that held the old ones are gone', async () => {
  const css = stripCssComments(await read('app/globals.css'));

  // `--radius-xl`/`-2xl`/`-3xl` aliased onto the card radius during the sweep
  // so that 319 un-edited call sites rendered correctly in the meantime. They
  // have no call sites left, and leaving them would let the noise back in
  // silently — a stray `rounded-xl` would keep looking right.
  for (const dead of ['--radius-xl', '--radius-2xl', '--radius-3xl']) {
    assert.doesNotMatch(css, new RegExp(`${dead}\\s*:`), `${dead} is an alias with no call sites`);
  }

  // The rule the three survivors encode: lg is a surface, md is a control,
  // sm is a chip. Anything outside that set is a fourth scale re-emerging.
  const offenders: string[] = [];
  for (const file of await appSources()) {
    const src = await readFile(file, 'utf8');
    for (const m of src.matchAll(/\brounded-(?:[trblse]{1,2}-)?([a-z0-9]+)\b/g)) {
      if (!['sm', 'md', 'lg', 'full'].includes(m[1])) {
        offenders.push(`${path.relative(ROOT, file)}: rounded-${m[1]}`);
      }
    }
    // Bare `rounded` is Tailwind's own fixed 0.25rem, which no token governs —
    // it happens to equal --radius-sm today and would drift the moment that
    // token moved. 89 sites were made explicit during the sweep.
    if (/(?<=[\s"'`])rounded(?=[\s"'`])/.test(src)) {
      offenders.push(`${path.relative(ROOT, file)}: bare rounded`);
    }
  }
  assert.deepEqual(offenders, [], `radius scale drifted:\n${offenders.join('\n')}`);
});

// ---------------------------------------------------------------------------
// 8. Shadows stay off everything that is not floating
// ---------------------------------------------------------------------------

test('the only shadow in the app is the overlay token', async () => {
  // 168 sized shadows were deleted: depth was being used to separate flat,
  // co-planar surfaces from each other, which is what the border tokens are
  // for. A shadow now means one thing — this element floats above the page —
  // and 25 surfaces qualify: modals, dropdowns, popovers, docked widgets.
  const offenders: string[] = [];
  for (const file of await appSources()) {
    const src = await readFile(file, 'utf8');
    for (const m of src.matchAll(/\b((?:[a-z-]+:)*shadow-(?:sm|md|lg|xl|2xl))\b/g)) {
      offenders.push(`${path.relative(ROOT, file)}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, [], `sized shadows reintroduced:\n${offenders.join('\n')}`);

  // And the token has to exist, or every one of those 25 silently renders flat.
  const css = stripCssComments(await read('app/globals.css'));
  assert.match(css, /--shadow-overlay:\s*0 /, '--shadow-overlay has no light value');
  assert.match(
    css.slice(css.indexOf('@theme inline')),
    /--shadow-overlay:\s*var\(--shadow-overlay\)/,
    'shadow-overlay must be surfaced through @theme inline to switch with the theme',
  );
});

// ---------------------------------------------------------------------------
// 9. Hue means something, or it is not used
// ---------------------------------------------------------------------------

test('no decorative colour families survive', async () => {
  // The audit found 17 families. Thirteen of them carried no meaning at all —
  // six AI actions in six hues, notification tints, "info" panels in blue.
  // What is left is the accent (green/emerald), the two semantic tones (amber,
  // red) and the neutral ramp, all of which are being moved onto tokens.
  const DECORATIVE = [
    'indigo', 'purple', 'violet', 'blue', 'cyan', 'fuchsia',
    'lime', 'orange', 'yellow', 'teal', 'sky', 'pink', 'rose',
  ];
  const pattern = new RegExp(`\\b[a-z-]+-(?:${DECORATIVE.join('|')})-\\d+`, 'g');

  const offenders: string[] = [];
  for (const file of await appSources()) {
    const src = await readFile(file, 'utf8');
    for (const m of src.matchAll(pattern)) {
      offenders.push(`${path.relative(ROOT, file)}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `decorative colour reintroduced:\n${offenders.join('\n')}`);
});

test('the accuracy scale is defined once, in tokens', async () => {
  // The heatmap is the one place hue still carries information. Its five bands
  // were hardcoded twice — once in bandFor() and once in the legend beside it,
  // which is exactly how a legend drifts from the thing it explains.
  const css = stripCssComments(await read('app/globals.css'));
  const dark = css.slice(css.indexOf('.dark {'), css.indexOf('@theme inline'));
  for (let i = 1; i <= 5; i += 1) {
    assert.match(css, new RegExp(`--band-${i}:\\s*#`), `--band-${i} has no light value`);
    assert.match(dark, new RegExp(`--band-${i}:\\s*#`), `--band-${i} has no dark value`);
  }

  const src = await read('app/components/WeaknessHeatmap.tsx');
  assert.doesNotMatch(src, /bg-(emerald|green|yellow|orange|red)-\d/, 'the scale left its tokens');
});
