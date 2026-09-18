import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full;
  }
}

async function sources(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (const base of ['app/api', 'lib']) {
    for await (const file of walk(join(ROOT, base))) {
      out.push({ path: relative(ROOT, file), text: await readFile(file, 'utf8') });
    }
  }
  return out;
}

/**
 * The monthly per-student cap only works if everything that spends consults it.
 *
 * `checkAiAllowance` reserves before the provider call and never refunds, which
 * is what makes the ceiling hold under concurrent serverless requests. A file
 * that calls a paid provider and books `recordUsage` without first taking an
 * allowance spends money outside that ceiling, and nothing else in the system
 * would notice -- the usage row is written either way, so /usage looks normal
 * while the cap silently does not apply.
 */
test('every file that records AI usage also takes an allowance', async () => {
  const offenders: string[] = [];
  for (const { path, text } of await sources()) {
    // lib/rate-limit.ts defines both; it is the implementation, not a caller.
    if (path === 'lib/rate-limit.ts') continue;
    if (!/\brecordUsage\s*\(/.test(text)) continue;
    if (!/\bcheckAiAllowance\s*\(/.test(text)) offenders.push(path);
  }
  assert.deepEqual(
    offenders,
    [],
    `these spend without consulting the cap:\n  ${offenders.join('\n  ')}`,
  );
});

test('the cap is a real number with a conservative default', async () => {
  const text = await readFile(join(ROOT, 'lib/rate-limit.ts'), 'utf8');
  assert.match(text, /AI_MONTHLY_USER_SPEND_LIMIT_USD/);
  assert.match(
    text,
    /positiveNumber\(\s*process\.env\.AI_MONTHLY_USER_SPEND_LIMIT_USD,\s*5,?\s*\)/,
    'an unset env var must fall back to a real ceiling, never to unlimited',
  );
});

test('spend is reserved before the call, not measured after it', async () => {
  const text = await readFile(join(ROOT, 'lib/rate-limit.ts'), 'utf8');
  // Summing UsageRecord rows after the provider answers can always overshoot
  // under concurrency: two requests both read a total below the cap, both
  // proceed, and the cap is breached by however many were in flight.
  assert.match(text, /reserveMonthlyAiSpend/);
  assert.doesNotMatch(
    text,
    /usageRecord\.aggregate[\s\S]{0,400}?AI_MONTHLY_USER_SPEND_LIMIT_USD/,
    'the ceiling must not be derived by summing past usage',
  );
});

test("a student's own key is not charged against the owner's budget", async () => {
  const text = await readFile(join(ROOT, 'lib/rate-limit.ts'), 'utf8');
  assert.match(text, /source\?:\s*'user'\s*\|\s*'shared'/);
  // BYOK is billed by the student's own provider, so the owner's dollar cap is
  // not theirs to spend -- but the per-minute limiter still applies, because
  // that one protects this platform rather than the wallet.
  assert.match(text, /aiLimiter\.check\(`ai-minute:\$\{userId\}`\)/);
});
