import { test, expect } from '@playwright/test';
import { record, attachDiagnostics, TEST_PASSWORD } from './helpers';

const EMAIL = process.env.E2E_EMAIL ?? 'e2e.tester@e2e.invalid';

test.describe('auth (signed out)', () => {
  test('protected APIs refuse an anonymous caller', async ({ request }) => {
    const paper = await request.get('/api/papers/1');
    expect(paper.status(), 'GET /api/papers/1 while signed out').toBe(401);

    const file = await request.get('/api/papers/1/file', { maxRedirects: 0 });
    expect(file.status(), 'GET /api/papers/1/file while signed out').toBe(401);

    const upload = await request.get('/uploads/does-not-exist.png', { maxRedirects: 0 });
    expect(upload.status(), 'GET /uploads/** while signed out').toBe(401);

    const extracted = await request.get('/extracted_images/does-not-exist.png', { maxRedirects: 0 });
    expect(extracted.status(), 'GET /extracted_images/** while signed out').toBe(401);

    const step = await request.get('/step-images/does-not-exist.png', { maxRedirects: 0 });
    expect(step.status(), 'GET /step-images/** while signed out').toBe(401);
  });

  test('wrong password is rejected with an error message', async ({ page }, testInfo) => {
    const r = record(page);
    await page.goto('/auth/login');
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill('definitely-not-the-password');
    await page.getByRole('button', { name: /sign in|log in/i }).first().click();
    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    expect(page.url()).toContain('/auth/login');
    await attachDiagnostics(testInfo, r, page);
  });

  test('login lands in the app and the session survives a reload', async ({ page }, testInfo) => {
    const r = record(page);
    await page.goto('/auth/login');
    await page.locator('input[type="email"]').first().fill(EMAIL);
    await page.locator('input[type="password"]').first().fill(TEST_PASSWORD);
    await page.getByRole('button', { name: /sign in|log in/i }).first().click();

    await expect(page.getByRole('button', { name: /^Dashboard$/ })).toBeVisible({ timeout: 60_000 });
    expect(new URL(page.url()).pathname).toBe('/');

    // Session persistence: full reload, then a fresh tab in the same context.
    await page.reload();
    await expect(page.getByRole('button', { name: /^Dashboard$/ })).toBeVisible({ timeout: 60_000 });

    const second = await page.context().newPage();
    await second.goto('/papers');
    await expect(second.getByRole('heading', { name: /past papers/i })).toBeVisible();
    const session = await second.request.get('/api/auth/session');
    expect(session.ok()).toBeTruthy();
    const body = await session.json();
    expect(body?.user?.email, 'session endpoint after reload').toBeTruthy();
    await second.close();

    await attachDiagnostics(testInfo, r, page);
  });

  test('signed-out UI offers a way in rather than app content', async ({ page }, testInfo) => {
    const r = record(page);
    await page.goto('/');
    await expect(page.getByRole('link', { name: /sign in|log in/i }).first()).toBeVisible({ timeout: 60_000 });
    await attachDiagnostics(testInfo, r, page);
  });
});
