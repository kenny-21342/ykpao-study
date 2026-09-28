import { test, expect } from '@playwright/test';
import { record, attachDiagnostics } from './helpers';

test.describe('notes', () => {
  test('the materials workspace renders for a signed-in student', async ({ page }, testInfo) => {
    const r = record(page);
    await page.goto('/?tab=materials');
    await expect(page.getByRole('heading', { name: /^Materials$/ }).first()).toBeVisible({ timeout: 90_000 });
    // The view toggle in the Materials header (other panes reuse these words).
    //
    // Addressed through the radiogroup rather than "the last div containing the
    // heading". Two things broke that: the toggle moved into PageHeader's
    // `actions`, which is a SIBLING of the div wrapping the h1, so the old
    // locator could never reach it; and SegmentedControl renders role="radio"
    // inside role="radiogroup", not plain buttons, so getByRole('button') would
    // have missed it wherever it sat. The aria-label is the stable handle.
    const toggle = page.getByRole('radiogroup', { name: /materials view/i });
    const notebookTab = toggle.getByRole('radio', { name: 'Notebook', exact: true }).first();
    const libraryTab = toggle.getByRole('radio', { name: 'Library', exact: true }).first();
    await expect(notebookTab).toBeVisible();

    // Switch to the library and back; both panes must mount without throwing.
    await libraryTab.click();
    await page.waitForTimeout(3000);
    await notebookTab.click();
    await page.waitForTimeout(3000);

    expect(r.pageErrors, 'uncaught exceptions in the materials tab').toEqual([]);
    await attachDiagnostics(testInfo, r, page);
  });

  test('note and page APIs answer an authenticated student', async ({ page }) => {
    const notes = await page.request.get('/api/notes');
    expect(notes.status(), 'GET /api/notes').toBe(200);

    // /api/pages is a single-page read; without pageId a 400 is the contract.
    const pages = await page.request.get('/api/pages');
    expect(pages.status(), 'GET /api/pages without pageId').toBe(400);

    const notebooks = await page.request.get('/api/notebooks');
    expect(notebooks.status(), 'GET /api/notebooks').toBe(200);
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
