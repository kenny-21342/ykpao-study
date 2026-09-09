import { test, expect } from '@playwright/test';
import { record, attachDiagnostics } from './helpers';

/**
 * Batch B item 7b and Feature 3: the notebook editor's preview toggle, the
 * bold/italic input rules, and the live LaTeX linter.
 *
 * These run against a page the spec creates and deletes, so a rerun never
 * depends on what the previous one left behind -- the suite has to pass twice
 * consecutively to be worth anything as a regression gate.
 */

type Ids = { notebookId: string; sectionId: string; pageId: string };

async function createScratchPage(request: import('@playwright/test').APIRequestContext): Promise<Ids> {
  const stamp = Date.now().toString(36);
  // All three routes return the created row directly, not wrapped.
  const nb = await request.post('/api/notebooks', { data: { name: `e2e notebook ${stamp}` } });
  expect(nb.status(), 'POST /api/notebooks').toBe(201);
  const notebookId = (await nb.json()).id as string;

  const sec = await request.post('/api/sections', { data: { notebookId, name: `e2e section ${stamp}` } });
  expect(sec.status(), 'POST /api/sections').toBe(201);
  const sectionId = (await sec.json()).id as string;

  const pg = await request.post('/api/pages', { data: { sectionId, title: `e2e page ${stamp}` } });
  expect(pg.status(), 'POST /api/pages').toBe(201);
  const pageId = (await pg.json()).id as string;

  return { notebookId, sectionId, pageId };
}

test.describe('notebook editor', () => {
  let ids: Ids;

  test.beforeEach(async ({ request }) => {
    ids = await createScratchPage(request);
  });

  test.afterEach(async ({ request }) => {
    // Deleting the notebook cascades to its sections and pages.
    if (ids?.notebookId) {
      await request.delete(`/api/notebooks?notebookId=${ids.notebookId}`).catch(() => {});
    }
  });

  test('bold, italic and the triple-asterisk case all live-render', async ({ page }, testInfo) => {
    const r = record(page);
    await page.goto(`/?tab=notes-textbook&pageId=${ids.pageId}`);

    const editor = page.locator('.ProseMirror').first();
    await expect(editor).toBeVisible({ timeout: 90_000 });
    await editor.click();

    // Typed forward at a collapsed cursor, which is the only thing input
    // rules ever fire on.
    await page.keyboard.type('**bold** and *italic* and ***both*** done');

    await expect(editor.locator('strong').first()).toBeVisible();
    await expect(editor.locator('em').first()).toBeVisible();
    // ***both*** is the specific gap item 7b-ii closed: Bold's and Italic's
    // default regexes both fail their boundary checks with an extra adjacent
    // asterisk, so this needs the custom rule to produce nested marks.
    await expect(editor.locator('strong em, em strong').first()).toBeVisible();

    expect(r.pageErrors).toEqual([]);
    await attachDiagnostics(testInfo, r, page);
  });

  test('the LaTeX linter flags broken math and clears when it is fixed', async ({ page }, testInfo) => {
    const r = record(page);
    await page.goto(`/?tab=notes-textbook&pageId=${ids.pageId}`);

    const editor = page.locator('.ProseMirror').first();
    await expect(editor).toBeVisible({ timeout: 90_000 });
    await editor.click();

    // Unbalanced braces: KaTeX throws, so the decoration must appear -- with
    // no save and no reload, which is the whole point of a live linter.
    await page.keyboard.type('$x^{2$');
    await expect(editor.locator('.latex-lint-error').first()).toBeVisible({ timeout: 15_000 });

    // Close the brace and the squiggle must go away again.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('}');
    await expect(editor.locator('.latex-lint-error')).toHaveCount(0, { timeout: 15_000 });

    expect(r.pageErrors).toEqual([]);
    await attachDiagnostics(testInfo, r, page);
  });

  test('preview mode renders the page read-only without the shared-page banner', async ({ page }, testInfo) => {
    const r = record(page);
    await page.goto(`/?tab=notes-textbook&pageId=${ids.pageId}`);

    const editor = page.locator('.ProseMirror').first();
    await expect(editor).toBeVisible({ timeout: 90_000 });
    await editor.click();
    await page.keyboard.type('Preview me');

    await page.getByRole('button', { name: /preview/i }).first().click();

    await expect(page.getByText('Preview me')).toBeVisible({ timeout: 15_000 });
    // An owner toggling preview themselves must not be told the page is
    // shared read-only -- that copy is for the no-permission case only.
    await expect(page.getByText(/shared read-only page/i)).toHaveCount(0);
    // And the editor itself is gone, not merely disabled.
    await expect(page.locator('.ProseMirror')).toHaveCount(0);

    expect(r.pageErrors).toEqual([]);
    await attachDiagnostics(testInfo, r, page);
  });
});
