import { test, expect } from '@playwright/test';
import { record, attachDiagnostics } from './helpers';

test.describe('notes', () => {
  test('the materials workspace renders for a signed-in student', async ({ page }, testInfo) => {
    const r = record(page);
    await page.goto('/?tab=materials');
    await expect(page.getByRole('heading', { name: /^Materials$/ }).first()).toBeVisible({ timeout: 90_000 });
    // The view toggle in the Materials header (other panes reuse these words).
    const toggle = page.locator('div').filter({ has: page.getByRole('heading', { name: /^Materials$/ }) }).last();
    const notebookTab = toggle.getByRole('button', { name: 'Notebook', exact: true }).first();
    const libraryTab = toggle.getByRole('button', { name: 'Library', exact: true }).first();
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
      const posts = await page.request.get(`/api/discussions/threads/${list[0].id}/posts`);
      expect(posts.status(), 'GET thread posts').toBe(200);
    }
  });
});
