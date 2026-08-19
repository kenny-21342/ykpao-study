import { test as setup, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

export const STATE_PATH = path.join(__dirname, '.auth', 'student.json');

/**
 * Signs in the seeded E2E student and caches the session cookie.
 *
 * NOTE: this deliberately does NOT go through /auth/signup. Signup is
 * currently hard-blocked by the rate limiter (see auth.spec.ts) on any
 * database that lacks the `rate_limits` table, so the account is seeded
 * out-of-band and the signup path is asserted on separately.
 */
setup('authenticate', async ({ page }) => {
  const email = process.env.E2E_EMAIL ?? 'e2e.tester@e2e.invalid';
  const password = process.env.E2E_PASSWORD ?? 'E2eTester!2026';

  await page.goto('/auth/login');
  await page.locator('input[type="email"]').first().fill(email);
  await page.locator('input[type="password"]').first().fill(password);
  await page.getByRole('button', { name: /sign in|log in/i }).first().click();

  await expect(page.getByRole('button', { name: /^Dashboard$/ })).toBeVisible({ timeout: 45_000 });

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  await page.context().storageState({ path: STATE_PATH });
});
