import { test, expect } from '@playwright/test';
import { record, attachDiagnostics } from './helpers';

test.describe('materials', () => {
  test('the materials tab renders for a signed-in student', async ({ page }, testInfo) => {
    const r = record(page);
    await page.goto('/?tab=materials');
    await expect(page.getByRole('heading', { name: /^Materials$/ }).first()).toBeVisible({ timeout: 90_000 });
    expect(r.pageErrors, 'uncaught exceptions in the materials tab').toEqual([]);
    await attachDiagnostics(testInfo, r, page);
  });

  // `935f6ec` removed the Notebook -> Section -> Page workspace, so /api/pages,
  // /api/notebooks and /api/page-drawings are gone and the Notebook/Library
  // toggle no longer exists. The assertions against them were left behind and
  // failed the nightly run every night from 28 Sep. The legacy flat note API
  // survived the removal, so it is what remains worth asserting here.
  test('the note API answers an authenticated student', async ({ page }) => {
    const notes = await page.request.get('/api/notes');
    expect(notes.status(), 'GET /api/notes').toBe(200);
  });
});

test.describe('discussion threads', () => {
  test('the board lists threads and opens the composer', async ({ page }, testInfo) => {
    const r = record(page);
    await page.goto('/?tab=discussions');

    await expect(page.getByRole('button', { name: /New Thread/i })).toBeVisible({ timeout: 90_000 });

    // Open and close the composer. Deliberately no submit: this drives the
    // shared dev database and the run should stay read-only.
    await page.getByRole('button', { name: /New Thread/i }).click();
    await expect(page.getByRole('heading', { name: /New Thread/i })).toBeVisible();
    await expect(page.getByPlaceholder(/Help with/i)).toBeVisible();
    await page.getByRole('button', { name: /^Cancel$/ }).click();

    expect(r.pageErrors, 'uncaught exceptions on the discussion board').toEqual([]);
    await attachDiagnostics(testInfo, r, page);
  });

  test('thread API answers an authenticated student', async ({ page }) => {
    const threads = await page.request.get('/api/discussions/threads');
    expect(threads.status(), 'GET /api/discussions/threads').toBe(200);
    const body = await threads.json();
    const list = Array.isArray(body) ? body : (body.threads ?? body.items);
    expect(Array.isArray(list), 'threads payload is a list').toBeTruthy();

    if (list.length > 0) {
      const one = await page.request.get(`/api/discussions/threads/${list[0].id}`);
      expect(one.status(), 'GET one thread').toBe(200);

      // Posts arrive with the thread itself -- .../threads/[id] includes them,
      // filtered so moderator-hidden posts never reach the client. There is no
      // GET .../posts collection route by design (that path exports POST only),
      // so asserting one here only ever tested a 405.
      const thread = await one.json();
      expect(Array.isArray(thread.posts ?? thread.thread?.posts), 'thread payload carries its posts').toBeTruthy();
    }
  });
});
