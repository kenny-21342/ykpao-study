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

/**
 * The six tab views of the shell, and the component that draws each one.
 * `dashboard` is drawn by HomeShell itself.
 */
const TAB_VIEWS = [
  'HomeShell.tsx',
  'StudyCoach.tsx',
  // Practice renders BankPractice by default and QuestionsDatabase only when
  // a link names a legacy question, so both are "the Practice screen" and both
  // have to carry a title. BankPractice shipped with none.
  'BankPractice.tsx',
  'QuestionsDatabase.tsx',
  // Materials is two sub-views behind one hub, and the hub owns the title for
  // both: the notebook has no page header to put one in, and when the library
  // carried its own the screen showed two titles in one view and none in the
  // other.
  'MaterialsHub.tsx',
  'MockExams.tsx',
  'DiscussionBoard.tsx',
];

/** These render outside the shell and are their own page, so they own an h1. */
const OUTSIDE_SHELL = ['LandingPage.tsx', 'LegalPage.tsx', 'PaperBrowser.tsx', 'PaperViewer.tsx'];

/**
 * A title reaches the page either as a literal <h1> or through <PageHeader>,
 * which renders one. Counting only the literal is how Mock Exams carried two
 * titles with this test green: the shell drew one and PageHeader drew the
 * other, and nothing here could see the second.
 */
const titleCount = (src: string) =>
  (src.match(/<h1\b/g) ?? []).length + (src.match(/<PageHeader\b/g) ?? []).length;

test('each view has exactly one page title', async () => {
  // The rule is the same one AppChrome already followed, now applied to the
  // shell: the chrome carries navigation and actions, and the page under it
  // owns its title. The bar used to title the view too, so Mock Exams and
  // Discussions printed their own name twice, at two sizes, as two <h1>s.
  const dir = path.join(ROOT, 'app/components');

  for (const name of TAB_VIEWS) {
    const src = stripComments(await readFile(path.join(dir, name), 'utf8'));
    assert.equal(titleCount(src), 1, `${name} must render exactly one page title`);
  }

  // Nothing else rendered inside the shell may add one.
  const offenders: string[] = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.tsx')) continue;
    if (TAB_VIEWS.includes(name) || OUTSIDE_SHELL.includes(name)) continue;
    const src = stripComments(await readFile(path.join(dir, name), 'utf8'));
    if (titleCount(src) > 0) offenders.push(name);
  }
  assert.deepEqual(offenders, [],
    `a second page title inside the shell:\n${offenders.join('\n')}`);
});

test('the shell header carries no title of its own', async () => {
  // Its one <h1> is the dashboard greeting in the body, not a per-tab label in
  // the bar. A switch over activeTab inside the <header> is the old duplicate
  // coming back.
  const src = stripComments(
    await readFile(path.join(ROOT, 'app/components/HomeShell.tsx'), 'utf8'),
  );
  const header = src.slice(src.indexOf('<header'), src.indexOf('</header>'));
  assert.doesNotMatch(header, /<h1/, 'the shell header must not title the view; the page owns it');
});
