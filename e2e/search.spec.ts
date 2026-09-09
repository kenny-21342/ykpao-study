import { test, expect } from '@playwright/test';
import { record, attachDiagnostics } from './helpers';

/**
 * Feature 6: the global search palette.
 *
 * The regression worth guarding is that the palette went to production
 * returning nothing at all for the largest corpus on the platform -- the RAG
 * query excluded `question`/`markscheme` on the assumption that direct queries
 * covered them, and no direct query touches `past_paper_questions`. So these
 * assert on the *result types* reached, not merely that something came back.
 */
test.describe('global search', () => {
  test('the palette opens from the sidebar and shows its empty state', async ({ page }, testInfo) => {
    const r = record(page);
    await page.goto('/?tab=dashboard');

    const trigger = page.getByRole('button', { name: /^Search/ }).first();
    await expect(trigger).toBeVisible({ timeout: 90_000 });
    await trigger.click();

    const input = page.getByPlaceholder(/search/i).first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/at least 2 characters/i)).toBeVisible();

    expect(r.pageErrors).toEqual([]);
    await attachDiagnostics(testInfo, r, page);
  });

  test('a subject query reaches the past-paper corpus, not just the bank', async ({ request }) => {
    // `scope=all` so the assertion does not depend on which courses the test
    // account happens to be enrolled in.
    const res = await request.get('/api/search?q=hydrogen%20bonding&scope=all');
    expect(res.status(), 'GET /api/search').toBe(200);
    const results = (await res.json()).results as { type: string; title: string; snippet: string }[];

    expect(results.length, 'the query returned results at all').toBeGreaterThan(0);
    // Both halves of the corpus, which is exactly what the shipped filter cut off.
    expect(results.some((row) => row.type === 'question'), 'questions are reachable').toBe(true);
    expect(results.some((row) => row.type === 'markscheme'), 'mark schemes are reachable').toBe(true);

    // Snippets are prose, not the extractor's raw marking_points JSON.
    for (const row of results) {
      expect(row.snippet.trimStart().startsWith('{"marking_points"'), `snippet for ${row.title}`).toBe(false);
    }

    // One document, one row: the past-paper corpus stores a question's plain
    // text and its LaTeX rendering separately, and both index under one title.
    const titles = results.map((row) => `${row.type}:${row.title}`);
    expect(new Set(titles).size, 'no duplicate results').toBe(titles.length);
  });

  test('a short or empty query is answered without a database sweep', async ({ request }) => {
    for (const q of ['', 'a']) {
      const res = await request.get(`/api/search?q=${encodeURIComponent(q)}`);
      expect(res.status(), `GET /api/search?q=${q || '(empty)'}`).toBe(200);
      expect((await res.json()).results, 'below the minimum length').toEqual([]);
    }
  });
});
