import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import dotenv from 'dotenv';

/**
 * Playwright is not Next.js: nothing here reads `.env.local` on its own, so
 * the three E2E variables had to be typed on the command line every run. Load
 * the same file `next dev` does, without overriding anything already exported
 * in the shell — so a one-off `E2E_BASE_URL=... npm run e2e` still wins.
 */
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

const STATE_PATH = path.join(__dirname, '.auth', 'student.json');

/**
 * E2E config for the YKPao Study platform.
 *
 * These tests drive a real database, so they deliberately do not spawn or tear
 * down a server of their own — point them at one that is already running.
 *
 * `E2E_BASE_URL` is required rather than defaulted. It used to fall back to
 * `http://localhost:3200`, which meant "whatever database the local dev server
 * happens to be pointed at" — and for a long time that was the `smart-edu`
 * Neon project, whose migration history predates the squash to
 * `00000000000000_init` and carries a failed `add_competition_questions` row.
 * `prisma migrate deploy` cannot move it forward; it can only be recreated. A
 * suite that silently runs against a schema that old reports green while
 * exercising none of the features it was written for, which is worse than
 * refusing to start.
 *
 * Point it at a deployment, or at a local server backed by a Neon branch of
 * production:
 *
 *   E2E_BASE_URL=https://study.busypizza.bond npm run e2e
 *
 * Timeouts are generous because several routes on this app are genuinely slow
 * (/api/onboarding alone can take 65s).
 */
const baseURL = process.env.E2E_BASE_URL;
if (!baseURL) {
  throw new Error(
    'E2E_BASE_URL is required. Point it at a running deployment, e.g.\n' +
      '  E2E_BASE_URL=https://study.busypizza.bond npm run e2e\n' +
      'Set E2E_EMAIL and E2E_PASSWORD too — auth.setup.ts signs in with them.',
  );
}

export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 30_000,
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'signed-out',
      testMatch: /auth\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'student',
      testIgnore: [/auth\.setup\.ts/, /auth\.spec\.ts/],
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: STATE_PATH },
    },
  ],
});
