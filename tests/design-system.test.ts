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

/**
 * Every Tailwind palette family the app may no longer name directly. The
 * accent (green/emerald) and the two semantic tones (amber, red) were the last
 * four to go, so the palette is closed: every colour comes from globals.css.
 */
const PALETTE_FAMILIES = [
  'indigo', 'purple', 'violet', 'blue', 'cyan', 'fuchsia',
  'lime', 'orange', 'yellow', 'teal', 'sky', 'pink', 'rose',
  'green', 'emerald', 'amber', 'red',
];

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
  const pattern = new RegExp(`\\b[a-z-]+-(?:${PALETTE_FAMILIES.join('|')})-\\d+`, 'g');

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
  // Palette families only — `bg-band-5` is the token and must not match.
  assert.doesNotMatch(
    src,
    new RegExp(`bg-(?:${PALETTE_FAMILIES.join('|')}|gray)-\\d`),
    'the scale left its tokens',
  );

  // Every band carries a label in --text-inverse, and --text-inverse FLIPS
  // with the theme: white on light, near-black on dark. So the light steps
  // have to be darker than the dark ones, which is the opposite of the
  // intuition and was wrong in three of five bands when first written.
  // Measured here rather than asserted in a comment.
  const srgb = (hex: string) =>
    [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
  const luminance = (hex: string) => {
    const [r, g, b] = srgb(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const valueOf = (block: string, prop: string) => {
    const m = block.match(new RegExp(`${prop}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(m, `${prop} not found`);
    return m![1];
  };

  const light = css.slice(0, css.indexOf('.dark {'));
  for (const [block, fg, label] of [[light, valueOf(light, '--text-inverse'), 'light'],
                                    [dark, valueOf(dark, '--text-inverse'), 'dark']] as const) {
    for (let i = 1; i <= 5; i += 1) {
      const ratio = contrast(valueOf(block, `--band-${i}`), fg);
      assert.ok(ratio >= 4.5, `${label} --band-${i} is ${ratio.toFixed(2)}:1 against its label, needs 4.5`);
    }
  }
});

// ---------------------------------------------------------------------------
// 10. The neutral ramp is tokens, not a light value plus a dark patch
// ---------------------------------------------------------------------------

test('no raw grey utility survives outside the deliberate translucent set', async () => {
  // 3,382 grey utilities, almost all written as a light/dark pair, which is
  // what made dark mode a patch rather than a theme. They are now ~20 tokens.
  //
  // Two things are deliberately still raw, and both are theme-independent on
  // purpose: `text-white` on a coloured surface (an accent button's label is
  // white in both themes) and translucent white glass over the sidebar blur
  // and the auth hero image.
  const RAW = /(?<![\w:./-])(?:[a-z-]+:)*(?:bg|text|border|divide)-(?:gray-\d+|white)(?![\w./-])/g;
  const offenders: string[] = [];
  for (const file of await appSources()) {
    const src = await readFile(file, 'utf8');
    for (const m of src.matchAll(RAW)) {
      if (/(?:^|:)text-white$/.test(m[0])) continue;
      offenders.push(`${path.relative(ROOT, file)}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `raw grey reintroduced:\n${offenders.join('\n')}`);
});

test('no dark: variant of a themed token', async () => {
  // A token already switches with the theme, so `dark:bg-surface` is at best
  // noise and at worst a claim that it does not — which is how the old
  // light-value-plus-dark-patch habit would grow back.
  const TOKENS = 'surface|surface-raised|surface-hover|surface-active|surface-inverse'
    + '|canvas|line|subtle|strong|primary|secondary|muted|inverse|accent|accent-text'
    + '|accent-subtle|warning|warning-subtle|danger|danger-subtle';
  const pattern = new RegExp(`\\bdark:(?:[a-z-]+:)*(?:bg|text|border|divide)-(?:${TOKENS})(?![\\w-])`, 'g');
  const offenders: string[] = [];
  for (const file of await appSources()) {
    const src = await readFile(file, 'utf8');
    for (const m of src.matchAll(pattern)) {
      offenders.push(`${path.relative(ROOT, file)}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `dark: variant of a themed token:\n${offenders.join('\n')}`);
});

// ---------------------------------------------------------------------------
// 11. Nothing compensates for the tokens after the fact
// ---------------------------------------------------------------------------

test('the compensation stylesheets are gone and nothing hardcodes a colour', async () => {
  const styles = await readdir(path.join(ROOT, 'app/styles'));
  assert.deepEqual(styles.sort(), ['chat.css', 'editor.css'],
    'a stylesheet reappeared beside the two that style DOM Tailwind cannot reach');

  // Those two are kept because ProseMirror and KaTeX render markup the app
  // does not author. They may not carry their own palette.
  for (const name of styles) {
    const css = stripCssComments(await readFile(path.join(ROOT, 'app/styles', name), 'utf8'));
    const literal = css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? [];
    assert.deepEqual(literal, [], `${name} hardcodes a colour instead of using a token`);
  }

  // !important was how the old layers beat the utilities they were correcting.
  // The Toaster keeps a few to beat react-hot-toast's own inline styles.
  const globals = stripCssComments(await read('app/globals.css'));
  assert.doesNotMatch(globals, /!important/, 'globals.css should not need to shout');
});

// ---------------------------------------------------------------------------
// 12. The dashboard stays consolidated
// ---------------------------------------------------------------------------

test('the dashboard does not grow back into a wall of boxes', async () => {
  const src = stripCssComments(await read('app/components/HomeShell.tsx'));
  const start = src.indexOf("{activeTab === 'dashboard' && (");
  // Not the `{/* VIEW 1: Study */}` marker — stripCssComments removes JSX
  // comments too, so anchoring on one silently yields an empty slice.
  const end = src.indexOf("{activeTab === 'study' && (");
  assert.ok(start > 0 && end > start, 'could not locate the dashboard block');
  const dashboard = src.slice(start, end);

  // Eleven to fourteen bordered boxes met a student on first load, three of
  // them stacked notices. Each inline card shell here is one of those.
  const shells = dashboard.match(/rounded-lg border border-line bg-surface\b/g) ?? [];
  assert.ok(shells.length <= 4,
    `${shells.length} inline card shells on the dashboard; it was consolidated to at most 4`);

  // One notice slot, not three stacked banners. AnnouncementBanner and
  // AiKeyPrompt must sit inside the same conditional as the stats error.
  const noticeSlot = dashboard.slice(
    dashboard.indexOf('{statsError ?'),
    dashboard.indexOf('Next step'),
  );
  assert.match(noticeSlot, /<AnnouncementBanner \/>/, 'the announcement banner left the notice slot');
  assert.match(noticeSlot, /<AiKeyPrompt \/>/, 'the AI-key card left the notice slot');

  // The four figures are one borderless row, not four cards with four accents.
  assert.match(dashboard, /<StatRow>/, 'the figures are not in a StatRow');
  assert.doesNotMatch(src, /statToneStyles/, 'the per-figure accent map came back');

  // The heatmap belongs to Study > Coverage, which is what ?tab=weaknesses
  // routes to; on the dashboard it was one more box for a new account.
  assert.doesNotMatch(dashboard, /<WeaknessHeatmap/, 'the heatmap is back on the dashboard');
  assert.match(
    stripCssComments(await read('app/components/StudyCoach.tsx')),
    /<WeaknessHeatmap \/>/,
    'the heatmap has no entrance at all',
  );
});

// ---------------------------------------------------------------------------
// 13. The styleguide keeps up with the tokens
// ---------------------------------------------------------------------------

test('every themed token appears on the styleguide page', async () => {
  // /admin/styleguide is the QA surface: the place a contrast pair can be
  // checked in both themes at once. A token that never reaches it is a token
  // nobody ever looks at, which is how three of the accuracy bands shipped
  // below 4.5:1.
  const css = stripCssComments(await read('app/globals.css'));
  const inline = css.slice(css.indexOf('@theme inline'), css.indexOf('@theme {'));
  const tokens = [...inline.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]);
  assert.ok(tokens.length > 20, 'expected the token block to be found');

  const page = await read('app/admin/styleguide/page.tsx');
  // These are foregrounds and utilities shown *through* the pairs above, not
  // swatches of their own.
  const SHOWN_VIA_PAIRS = new Set([
    'accent-fg', 'accent-text', 'accent-border', 'inverse',
    'danger-border', 'warning-border', 'background', 'foreground', 'ring',
  ]);
  const missing = tokens.filter((t) => !SHOWN_VIA_PAIRS.has(t) && !page.includes(t));
  assert.deepEqual(missing, [], `tokens with no swatch on the styleguide: ${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------
// 14. The accent is one hue, including where CSS variables cannot reach
// ---------------------------------------------------------------------------

test('the accent literal matches the token everywhere a variable cannot be used', async () => {
  // Four places cannot read --accent: the PWA manifest (consumed by the OS),
  // global-error.tsx (it replaces the root layout, so no stylesheet), and the
  // two transactional email templates (no client supports custom properties).
  // All four were still on the old emerald-500 after the accent changed.
  const css = stripCssComments(await read('app/globals.css'));
  const light = css.slice(0, css.indexOf('.dark {'));
  const accent = light.match(/--accent:\s*(#[0-9A-Fa-f]{6})/)?.[1];
  assert.ok(accent, '--accent has no light value');

  for (const file of [
    'app/manifest.ts',
    'app/global-error.tsx',
    'lib/password-reset.ts',
    'lib/email-verification.ts',
  ]) {
    const src = await read(file);
    assert.match(src, new RegExp(accent!, 'i'), `${file} does not use the accent`);
    // The specific hues the accent used to be.
    assert.doesNotMatch(src, /#10b981|#059669|#22c55e/i, `${file} still carries an old accent`);
  }
});

// ---------------------------------------------------------------------------
// 15. Nothing wider than a phone escapes its scroll container
// ---------------------------------------------------------------------------

test('anything wider than 390px sits in a horizontal scroll container', async () => {
  // A phone is ~390px. Content that cannot narrow -- a comparison table, a
  // fixed-size canvas -- is allowed to be wider, but only inside its own
  // overflow-x container, or the whole page scrolls sideways instead.
  const offenders: string[] = [];
  for (const file of await appSources()) {
    const lines = stripCssComments(await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/(?<![\w:-])min-w-\[(\d+)px\]/g)) {
        if (Number(m[1]) <= 390) continue;
        const context = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
        if (!/overflow-x-auto|overflow-auto|overflow-x-scroll/.test(context)) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1} ${m[0]}`);
        }
      }
    });
  }
  assert.deepEqual(offenders, [],
    `wider than a phone with nowhere to scroll:\n${offenders.join('\n')}`);
});
