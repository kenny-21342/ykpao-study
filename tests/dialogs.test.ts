import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The native dialogs stay gone.
 *
 * `window.confirm` survived in eleven places for a long time, and a previous
 * attempt at this migration converted one site and stopped. The reason to pin
 * it with a test rather than trust the sweep is that each one is a single
 * plausible-looking line -- `if (!confirm('...')) return;` -- that reads as
 * finished code, so the next one added would not look like a regression to
 * anybody reviewing it.
 *
 * `confirm` and `alert` block the event loop, which is why the worst of the
 * eleven mattered: it fired during a timed exam and froze the timer, the
 * autosave and the SSE connection until the student dismissed an OS dialog.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every .tsx/.ts under app/, which is all the client code there is. */
async function appSources(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        await walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  }
  await walk(join(root, 'app'));
  return out;
}

/**
 * The two files that are allowed to name these functions, because they are the
 * documentation for why they are not used.
 */
const ALLOWED = ['app/components/NoticeDialog.tsx', 'app/components/useConfirm.tsx'];

/** Strips comments so prose about `confirm()` does not read as a call. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

test('no component calls window.confirm, alert or prompt', async () => {
  const offenders: string[] = [];

  for (const file of await appSources()) {
    const relative = file.slice(root.length + 1);
    if (ALLOWED.includes(relative)) continue;

    const src = stripComments(await readFile(file, 'utf8'));

    // `window.`-qualified is unambiguous.
    if (/\bwindow\s*\.\s*(confirm|alert|prompt)\s*\(/.test(src)) {
      offenders.push(`${relative} (window.*)`);
    }

    // Bare calls. A leading dot or identifier character excludes a method or a
    // locally-defined helper of the same name -- FloatingAIAssistant really
    // does have its own `confirm()` for accepting an AI proposal, and it is
    // called as `void confirm()` with no argument.
    for (const m of src.matchAll(/(^|[^\w.$])(confirm|alert|prompt)\s*\(\s*['"`]/g)) {
      offenders.push(`${relative} (bare ${m[2]})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `native blocking dialogs found — use useConfirm() / NoticeDialog instead:\n${offenders.join('\n')}`,
  );
});

test('the shared dialog traps focus and gives it back', async () => {
  const src = await readFile(join(root, 'app/components/NoticeDialog.tsx'), 'utf8');

  // Focus handling lives here precisely so every modal in the app gets it from
  // one place; losing it here silently regresses all of them at once.
  assert.match(src, /restoreRef/, 'the dialog must remember what had focus');
  assert.match(src, /e\.key !== 'Tab'/, 'Tab must be trapped inside the dialog');
  assert.match(src, /document\.contains\(restore\)/, 'focus restore must survive an unmounted trigger');
  assert.match(src, /useId\(\)/, 'ids must be per-instance, not module constants');
});

test('a destructive dialog does not open with the destructive button focused', async () => {
  const src = await readFile(join(root, 'app/components/NoticeDialog.tsx'), 'utf8');
  // Enter is how a native confirm gets dismissed, so anyone acting from habit
  // must land on Cancel rather than complete a deletion they never read.
  assert.match(src, /destructive \|\| !isConfirm/);
  assert.match(src, /cancelRef\.current \?\? confirmRef\.current/);
});

test('useConfirm defaults to the destructive treatment', async () => {
  const src = await readFile(join(root, 'app/components/useConfirm.tsx'), 'utf8');
  // Every site it replaced was a delete or a data-loss warning. Opting *out*
  // for the two that are not is safer than opting in and forgetting.
  assert.match(src, /destructive \?\? true/);
});

test('a prompt asks for something rather than warning about it', async () => {
  const hook = await readFile(join(root, 'app/components/useConfirm.tsx'), 'utf8');
  const dialog = await readFile(join(root, 'app/components/NoticeDialog.tsx'), 'utf8');

  // A prompt must never wear the red destructive treatment: only a confirm
  // can be destructive, and everything else falls through to false.
  assert.match(hook, /destructive=\{pending\?\.kind === 'confirm' \? .* : false\}/);

  // Cancelling resolves null, not '', so a caller can tell "typed nothing"
  // from "did not answer" -- the two flag handlers rely on it.
  assert.match(hook, /settle\(isPrompt \? null : false\)/);

  // Enter submits, as it does in the native prompt this replaces.
  assert.match(dialog, /e\.key === 'Enter'/);

  // The dialog is remounted on every open, so the field starts clean. Closed
  // is a null render rather than an unmount, so without a fresh key it would
  // hold the last thing typed -- possibly on another thread entirely.
  assert.match(hook, /key=\{openCount\}/);
  assert.match(hook, /setOpenCount\(\(n\) => n \+ 1\)/);
  assert.ok(dialog.length > 0);
});

// ---------------------------------------------------------------------------
// Icon-only controls have accessible names
// ---------------------------------------------------------------------------

/**
 * `title` is a tooltip for a pointer and nothing at all for a screen reader,
 * so a button whose only child is an icon and whose only text is a `title` is
 * announced as "button" and nothing else. Forty-one of them were, across six
 * files -- the editor toolbar alone accounted for about thirty.
 *
 * The check is deliberately narrow: real DOM elements only. A `title` prop on
 * a custom component is a prop, not an attribute, and `ToolButton`-style
 * wrappers set the accessible name themselves.
 */
test('DOM controls with a title also carry an accessible name', async () => {
  const offenders: string[] = [];
  const domTags = ['button', 'a', 'input', 'select', 'textarea', 'Link'];

  for (const file of await appSources()) {
    const src = await readFile(file, 'utf8');

    // Both a literal `title="Delete"` and a dynamic `title={label}`. The
    // dynamic form is the one that hid from the first sweep: a regex looking
    // for quoted strings walks straight past it, and those controls are just
    // as unnamed.
    for (const m of src.matchAll(/title=(?:"[^"]{1,120}"|\{)/g)) {
      const openedAt = src.lastIndexOf('<', m.index);
      if (openedAt === -1) continue;

      const tag = /<\s*([A-Za-z][A-Za-z0-9]*)/.exec(src.slice(openedAt))?.[1] ?? '';
      if (!domTags.includes(tag)) continue;

      // The element's own opening tag, so an aria-label on a sibling or a
      // child does not count as a name for this one.
      const closedAt = src.indexOf('>', m.index);
      const openTag = closedAt === -1 ? '' : src.slice(openedAt, closedAt);
      if (!/aria-label(ledby)?[=\s]/.test(openTag)) {
        offenders.push(`${file.slice(root.length + 1)}: ${m[0]}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `icon-only controls announced as just "button" — add aria-label:\n${offenders.join('\n')}`,
  );
});

test('the editor toolbar names every button and reports toggle state', async () => {
  const src = await readFile(join(root, 'app/components/RichTextEditor.tsx'), 'utf8');

  // One shared MenuButton, so this is the single point where ~30 controls
  // either get a name or do not.
  assert.match(src, /aria-label=\{title\}/);
  assert.match(src, /aria-pressed=\{active === undefined \? undefined : active\}/);

  // The toolbar had no dark: variants at all — a white strip across a dark
  // editor.
  assert.match(src, /bg-gray-50 dark:bg-gray-800 border-b/);
});

test('the exam timer does not animate for reduced-motion users or narrate itself', async () => {
  const src = await readFile(join(root, 'app/components/MockExams.tsx'), 'utf8');

  assert.match(src, /motion-safe:animate-pulse/);
  // Any pulse NOT preceded by the motion-safe variant. Written as a lookbehind
  // because `motion-safe:animate-pulse` contains `animate-pulse`, so a plain
  // substring check passes trivially and tests nothing.
  assert.doesNotMatch(
    src,
    /(?<!motion-safe:)animate-pulse/,
    'unguarded pulse animations must not come back',
  );

  // role="timer" defaults aria-live to off, which is what a clock ticking once
  // a second needs; a polite live region would read it aloud every second for
  // the length of the paper.
  assert.match(src, /role="timer"/);
  const timerBlock = src.slice(src.indexOf('role="timer"'), src.indexOf('role="timer"') + 400);
  assert.doesNotMatch(timerBlock, /aria-live/);
});
