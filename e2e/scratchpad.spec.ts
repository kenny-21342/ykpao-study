import { test, expect } from '@playwright/test';
import { record, attachDiagnostics } from './helpers';

/**
 * Feature 1: a per-question scratchpad whose strokes survive a reload.
 *
 * The regression this exists to catch is not subtle: for the whole of the
 * batch that shipped it, *mounting* the canvas crashed the app into its error
 * boundary (an unstable ref feeding React state, plus a `useImperativeHandle`
 * with no dependency list). So the first assertion here is simply that the
 * panel opens at all and the app is still standing afterwards -- that alone
 * would have caught it.
 */

/** Open a question from the practice list and expand its scratchpad. */
async function openScratchpad(page: import('@playwright/test').Page) {
  await page.goto('/?tab=practice');
  const firstQuestion = page.getByRole('button', { name: /Question \d+/ }).first();
  await expect(firstQuestion).toBeVisible({ timeout: 90_000 });
  await firstQuestion.click();

  const toggle = page.getByRole('button', { name: /^Scratchpad$/ });
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await toggle.click();

  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  return canvas;
}

/** Drag across the canvas, which is what commits a stroke (pointer-up). */
async function drawStroke(
  page: import('@playwright/test').Page,
  canvas: import('@playwright/test').Locator,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('scratchpad canvas has no box');
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  // Intermediate moves matter: a single move to the end point can be
  // coalesced into a stroke too short for perfect-freehand to render.
  await page.mouse.move(box.x + (from.x + to.x) / 2, box.y + (from.y + to.y) / 2);
  await page.mouse.move(box.x + to.x, box.y + to.y);
  await page.mouse.up();
}

test.describe('per-question scratchpad', () => {
  test('opens without taking the app down', async ({ page }, testInfo) => {
    const r = record(page);
    const canvas = await openScratchpad(page);

    await expect(canvas).toBeVisible();
    // The error boundary's copy. Its presence means the tree unmounted.
    await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
    expect(r.pageErrors, 'uncaught exceptions while mounting the scratchpad').toEqual([]);

    await attachDiagnostics(testInfo, r, page);
  });

  test('strokes survive a reload of the question', async ({ page }, testInfo) => {
    const r = record(page);
    const canvas = await openScratchpad(page);

    const saved = page.waitForResponse(
      (res) => res.url().includes('/api/scratchpads') && res.request().method() === 'PUT',
      { timeout: 60_000 },
    );
    await drawStroke(page, canvas, { x: 60, y: 60 }, { x: 220, y: 180 });
    // Autosave is debounced ~1.5s; waiting on the PUT is what makes this
    // deterministic rather than a sleep long enough to be flaky either way.
    const putResponse = await saved;
    expect(putResponse.status(), 'PUT /api/scratchpads').toBe(200);

    const url = page.url();
    await page.reload();
    if (page.url() !== url) await page.goto(url);

    // Read the row back through the API the panel itself loads from, keyed by
    // whichever of the three question refs this surface used.
    const body = putResponse.request().postDataJSON() as {
      pastPaperQuestionId?: number;
      bankQuestionId?: number;
      mockExamItemId?: string;
    };
    const refQuery = body.pastPaperQuestionId
      ? `pastPaperQuestionId=${body.pastPaperQuestionId}`
      : body.bankQuestionId
        ? `bankQuestionId=${body.bankQuestionId}`
        : `mockExamItemId=${body.mockExamItemId}`;

    const fetched = await page.request.get(`/api/scratchpads?${refQuery}`);
    expect(fetched.status(), 'GET /api/scratchpads').toBe(200);
    const json = (await fetched.json()) as {
      scratchpad?: { strokesJson?: { strokes?: unknown[] }; previewImageUrl?: string | null };
    };
    expect(json.scratchpad, 'a scratchpad row exists for this question').toBeTruthy();
    expect(json.scratchpad?.strokesJson?.strokes?.length ?? 0, 'strokes persisted').toBeGreaterThan(0);
    // The plan's explicit assertion: a real uploaded path, never a data: URL,
    // because grading reads this field.
    const preview = json.scratchpad?.previewImageUrl ?? '';
    if (preview) expect(preview.startsWith('data:'), 'preview is an uploaded file, not a data URL').toBe(false);

    expect(r.pageErrors).toEqual([]);
    await attachDiagnostics(testInfo, r, page);
  });
});
