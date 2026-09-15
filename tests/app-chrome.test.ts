import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Routes that are real routes rather than tabs of app/page.tsx, and are
 * reachable from the sidebar. Each one a student can arrive at must draw the
 * sidebar, or they land somewhere with no navigation and no way back except
 * the browser's own Back button.
 */
const SHELL_ROUTES = ['papers', 'bank', 'account', 'usage', 'announcements'];

test('every sidebar-reachable route renders the app chrome', async () => {
  for (const route of SHELL_ROUTES) {
    const layout = path.join(ROOT, 'app', route, 'layout.tsx');
    const src = await readFile(layout, 'utf8').catch(() => null);
    assert.ok(src, `app/${route} has no layout.tsx, so it renders with no sidebar`);
    assert.match(src!, /<AppChrome/, `app/${route}/layout.tsx does not render AppChrome`);
  }
});

test('no page inside the chrome pins itself to the viewport height', async () => {
  // AppChrome owns the one scroll container. `min-h-screen` on a page inside it
  // forces that container past 100vh whatever the content is, which is the
  // double-scrollbar bug /papers shipped with.
  const offenders: string[] = [];
  for (const route of SHELL_ROUTES) {
    const dir = path.join(ROOT, 'app', route);
    const walk = async (d: string) => {
      for (const entry of await readdir(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith('.tsx')) {
          if ((await readFile(full, 'utf8')).includes('min-h-screen')) {
            offenders.push(path.relative(ROOT, full));
          }
        }
      }
    };
    if (await stat(dir).then(() => true, () => false)) await walk(dir);
  }
  assert.deepEqual(offenders, [], `min-h-screen inside the chrome:\n${offenders.join('\n')}`);
});

/**
 * The doc comment in AppChrome.tsx mentions the very things these assertions
 * search for, so a raw match finds the prose rather than the markup. Strip
 * comments first, the way the other source-reading tests here do.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the chrome has exactly one scroll container and no title of its own', async () => {
  const src = stripComments(
    await readFile(path.join(ROOT, 'app/components/AppChrome.tsx'), 'utf8'),
  );

  assert.equal((src.match(/overflow-y-auto/g) ?? []).length, 1,
    'a second scroll container inside the chrome is how double-scroll comes back');

  // Every page inside already owns an <h1>. /papers shipped two — one in this
  // header and one in PaperBrowser — until the chrome stopped rendering one.
  assert.doesNotMatch(src, /<h1/, 'the chrome must not render a heading; the page owns it');
});

test('each view has exactly one page title', async () => {
  // The shell header renders one <h1> per tab, and AppChrome renders none
  // because the routed pages own theirs. Either way a view gets exactly one —
  // so a component rendered inside the shell must not add a second.
  const dir = path.join(ROOT, 'app/components');
  const offenders: string[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.tsx') || name === 'HomeShell.tsx') continue;
    // Comments in these files discuss <h1> by name, so match the markup only.
    const src = stripComments(await readFile(path.join(dir, name), 'utf8'));
    // These render outside the shell and are their own page.
    if (['LandingPage.tsx', 'LegalPage.tsx', 'PaperBrowser.tsx', 'PaperViewer.tsx'].includes(name)) continue;
    if (/<h1\b/.test(src)) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    `a second <h1> inside the shell:\n${offenders.join('\n')}`);

  // And the shell itself titles the view once, in its header — not again in
  // the dashboard body, which is where the duplicate was.
  const shell = stripComments(
    await readFile(path.join(ROOT, 'app/components/HomeShell.tsx'), 'utf8'),
  );
  assert.equal((shell.match(/<h1\b/g) ?? []).length, 1,
    'HomeShell renders more than one <h1>; the dashboard used to add its own');
});
