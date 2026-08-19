import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const STATE_PATH = path.join(__dirname, '.auth', 'student.json');

/**
 * E2E config for the YKPao Study platform.
 *
 * Assumes a dev server is ALREADY running (`PORT=3200 npm run dev`) — these
 * tests drive a real Neon dev database, so they deliberately do not spawn or
 * tear down a server of their own.
 *
 * Timeouts are generous because several routes on this app are genuinely slow
 * (see the findings report: /api/onboarding alone can take 65s).
 */
export default defineConfig({
  testDir: '.',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3200',
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
