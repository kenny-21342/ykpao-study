import { test, expect, type Page } from '@playwright/test';
import { record, attachDiagnostics } from './helpers';

type Doc = { id: number; filename: string; docTypeLabel: string };
type Instance = { documents: Doc[]; subjectName: string; year: number };

/**
 * Find a paper whose bytes are actually retrievable right now.
 *
 * The R2 corpus upload is still running, so plenty of rows point at objects
 * that do not exist yet. A 404 from /file therefore means "not uploaded", not
 * "broken" — we walk the catalogue until we find one that resolves.
 */
async function findServeablePaper(page: Page): Promise<{ id: number; via: string; contentType: string } | null> {
  const catalogue = await (await page.request.get('/api/papers/catalogue')).json();
  for (const curriculum of catalogue.curricula.slice(0, 4)) {
    const scoped = await (await page.request.get(`/api/papers/catalogue?curriculum=${encodeURIComponent(curriculum.id)}`)).json();
    for (const subject of scoped.subjects.slice(0, 4)) {
      const years = await (
        await page.request.get(`/api/papers/catalogue?curriculum=${encodeURIComponent(curriculum.id)}&subject=${encodeURIComponent(subject.code)}`)
      ).json();
      for (const y of years.years.slice(0, 3)) {
        const sessions = await (
          await page.request.get(
            `/api/papers/catalogue?curriculum=${encodeURIComponent(curriculum.id)}&subject=${encodeURIComponent(subject.code)}&year=${y.year}`,
          )
        ).json();
        for (const s of sessions.sessions.slice(0, 2)) {
          const papers = await (
            await page.request.get(
              `/api/papers/catalogue/papers?subject=${encodeURIComponent(subject.code)}&year=${y.year}&session=${encodeURIComponent(s.session)}`,
            )
          ).json();
          for (const instance of (papers.instances ?? []) as Instance[]) {
            for (const doc of instance.documents) {
              const head = await page.request.get(`/api/papers/${doc.id}/file`, { maxRedirects: 0 });
              const status = head.status();
              if (status === 307 || status === 302) {
                return { id: doc.id, via: `redirect -> ${head.headers()['location']}`, contentType: '' };
              }
              if (status === 200 && (head.headers()['content-type'] ?? '').includes('pdf')) {
                return { id: doc.id, via: 'streamed by the app', contentType: head.headers()['content-type'] };
              }
            }
          }
        }
      }
    }
  }
  return null;
}

test('a past paper renders visible PDF pages in the browser', async ({ page }, testInfo) => {
  const r = record(page);

  // Every request the page makes, so we can prove where the bytes came from
  // and whether pdf.js used ranged requests.
  const requests: Array<{ url: string; method: string; range?: string }> = [];
  page.on('request', (req) => {
    const range = req.headers()['range'];
    if (/\/api\/papers\/|r2\.cloudflarestorage|r2\.dev|\.pdf/i.test(req.url())) {
      requests.push({ url: req.url().slice(0, 200), method: req.method(), range });
    }
  });
  const responses: Array<{ url: string; status: number; acceptRanges?: string; contentRange?: string; cors?: string }> = [];
  page.on('response', (res) => {
    if (/\/api\/papers\/|r2\.cloudflarestorage|r2\.dev|\.pdf/i.test(res.url())) {
      const h = res.headers();
      responses.push({
        url: res.url().slice(0, 200),
        status: res.status(),
        acceptRanges: h['accept-ranges'],
        contentRange: h['content-range'],
        cors: h['access-control-allow-origin'],
      });
    }
  });

  const found = await findServeablePaper(page);
  await testInfo.attach('paper-source', { body: JSON.stringify(found, null, 2), contentType: 'text/plain' });
  expect(found, 'no past paper in the catalogue had retrievable bytes').not.toBeNull();

  await page.goto(`/papers/${found!.id}`);

  // The viewer chrome first…
  await expect(page.getByRole('link', { name: /past papers/i })).toBeVisible({ timeout: 60_000 });

  // …then a real rendered page canvas.
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible({ timeout: 120_000 });

  await expect
    .poll(async () => canvas.evaluate((el: HTMLCanvasElement) => el.width * el.height), { timeout: 60_000 })
    .toBeGreaterThan(10_000);

  // Non-blank: sample the bitmap and require some ink.
  const ink = await canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext('2d');
    if (!ctx) return -1;
    const { data } = ctx.getImageData(0, 0, el.width, Math.min(el.height, 400));
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 200 && data[i + 1] < 200 && data[i + 2] < 200) dark++;
    }
    return dark;
  });
  expect(ink, 'dark pixels on the first rendered page').toBeGreaterThan(50);

  // Page count from the viewer toolbar.
  const body = await page.locator('body').innerText();
  expect(body, 'page-count indicator in the viewer toolbar').toMatch(/\/\s*\d+/);
  expect(body).not.toMatch(/Failed to load PDF|corrupted|URL has expired/i);

  await testInfo.attach('pdf-requests', { body: JSON.stringify({ requests, responses }, null, 2), contentType: 'text/plain' });
  await attachDiagnostics(testInfo, r, page);

  // Report (not assert) the R2 leg: with STORAGE_DRIVER unset the dev server
  // streams the bytes itself and no cross-origin fetch happens at all.
  const crossOrigin = responses.filter((x) => /cloudflarestorage|r2\.dev/.test(x.url));
  const ranged = requests.filter((x) => x.range);
  console.log('[pdf] cross-origin responses:', JSON.stringify(crossOrigin));
  console.log('[pdf] ranged requests:', JSON.stringify(ranged.slice(0, 10)));
  console.log('[pdf] all pdf-related requests:', JSON.stringify(requests, null, 1));
});
