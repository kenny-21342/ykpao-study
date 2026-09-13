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
