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

test('a past paper embeds via the browser\'s native PDF viewer', async ({ page }, testInfo) => {
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

  // …then the native <object> embed pointed at the authenticated file route.
  // Its own content (canvas/iframe/plugin UI) lives in a browser-internal
  // context Playwright can't inspect, so we assert on the embed element and
  // the underlying request/response instead of pixels.
  const embed = page.locator('object[type="application/pdf"]').first();
  await expect(embed).toBeVisible({ timeout: 60_000 });
  const dataAttr = await embed.getAttribute('data');
  expect(dataAttr, 'object[data] should point at the paper file route').toContain(`/api/papers/${found!.id}/file`);

  const fileResponse = await page.request.get(dataAttr!, { maxRedirects: 5 });
  expect(fileResponse.ok(), 'the embedded PDF resource should load successfully').toBeTruthy();
  expect(fileResponse.headers()['content-type'] ?? '').toContain('pdf');

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
