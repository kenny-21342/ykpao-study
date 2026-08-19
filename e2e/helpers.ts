import { Page, TestInfo, expect } from '@playwright/test';

export const TEST_PASSWORD = 'E2eTester!2026';

/** Unique-per-run address so reruns never collide on the 409 "already registered". */
export function newTestEmail(tag = 'e2e'): string {
  return `${tag}+${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}@e2e.invalid`;
}

export type Recorder = {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  badResponses: string[];
};

/** Attach console/network recorders. Call at the top of every test. */
export function record(page: Page): Recorder {
  const r: Recorder = { consoleErrors: [], pageErrors: [], failedRequests: [], badResponses: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') r.consoleErrors.push(m.text().slice(0, 500));
  });
  page.on('pageerror', (e) => r.pageErrors.push(String(e).slice(0, 500)));
  page.on('requestfailed', (req) =>
    r.failedRequests.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText}`),
  );
  page.on('response', (res) => {
    if (res.status() >= 400) r.badResponses.push(`${res.status()} ${res.request().method()} ${res.url()}`);
  });
  return r;
}

export async function attachDiagnostics(testInfo: TestInfo, r: Recorder, page?: Page) {
  const body = [
    `## page errors\n${r.pageErrors.join('\n') || '(none)'}`,
    `## console errors\n${r.consoleErrors.join('\n') || '(none)'}`,
    `## failed requests\n${r.failedRequests.join('\n') || '(none)'}`,
    `## >=400 responses\n${r.badResponses.join('\n') || '(none)'}`,
  ].join('\n\n');
  await testInfo.attach('diagnostics', { body, contentType: 'text/plain' });
  if (page) await testInfo.attach('page-text', { body: await page.locator('body').innerText(), contentType: 'text/plain' });
}

/** Register through the real signup form and land on the app. */
export async function signUp(page: Page, email: string, name = 'E2E Tester') {
  await page.goto('/auth/signup');
  await page.getByPlaceholder(/name/i).first().fill(name).catch(() => {});
  await page.locator('input[type="email"]').first().fill(email);
  const pw = page.locator('input[type="password"]');
  await pw.nth(0).fill(TEST_PASSWORD);
  if (await pw.count() > 1) await pw.nth(1).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: /sign up|create account|register/i }).first().click();
  await page.waitForURL((u) => !u.pathname.startsWith('/auth/signup'), { timeout: 30_000 });
}

export async function logIn(page: Page, email: string, password = TEST_PASSWORD) {
  await page.goto('/auth/login');
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole('button', { name: /sign in|log in/i }).first().click();
  await page.waitForURL((u) => !u.pathname.startsWith('/auth/login'), { timeout: 30_000 });
}

/** Dismiss the onboarding wizard if it is blocking the app shell. */
export async function skipOnboardingIfPresent(page: Page) {
  const skip = page.getByRole('button', { name: /skip|later|not now|maybe later/i }).first();
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

export { expect };
