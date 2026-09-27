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

test('the monthly cap is off only when someone explicitly asks for it', async () => {
  /**
   * Added 27 Sep 2026 at the owner's request, after the $5 default locked his
   * own account out mid-testing: the reservation is a flat $0.02 per call and
   * is never refunded, so it is really a 250-calls-a-month quota.
   *
   * The invariant that matters is the one above — an unset variable still
   * falls back to a real ceiling. Off has to be a decision someone typed, not
   * a state the system can drift into by losing a value.
   */
  const { isMonthlyCapDisabled } = await import('../lib/spend-cap.ts');
  for (const value of [undefined, '', '5', '0.5', '100', 'abc', ' ']) {
    assert.equal(isMonthlyCapDisabled(value), false, `"${value}" must not disable the cap`);
  }
  for (const value of ['off', 'OFF', ' off ', '0', 'none', 'unlimited']) {
    assert.equal(isMonthlyCapDisabled(value), true, `"${value}" must disable the cap`);
  }
});

test('turning the monthly cap off does not touch the per-minute limiter', async () => {
  // The throttle and the ceiling are different controls doing different jobs.
  // With the ceiling off, `aiLimiter` is the only thing left, so it must not
  // be inside the same early return.
  const text = await readFile(join(ROOT, 'lib/rate-limit.ts'), 'utf8');
  const gate = text.slice(text.indexOf('export async function checkAiAllowance'));
  const limiterAt = gate.indexOf('aiLimiter.check');
  const capOffAt = gate.indexOf('monthlyCapOff()');
  assert.ok(limiterAt > -1 && capOffAt > -1);
  assert.ok(
    limiterAt < capOffAt,
    'the per-minute check must run before the cap can be short-circuited',
  );
});

/**
 * The platform-wide ceiling.
 *
 * Added 27 Sep 2026, immediately after the per-user cap was switched off in
 * production so that every student could use the tutor. That left `aiLimiter`
 * — 20 requests a minute *each* — as the only bound on a shared key funded by
 * a fixed personal donation with no billing alert behind it.
 */
test('the platform-wide cap is a real number with a conservative default', async () => {
  const text = await readFile(join(ROOT, 'lib/rate-limit.ts'), 'utf8');
  assert.match(
    text,
    /positiveNumber\(\s*process\.env\.AI_MONTHLY_TOTAL_SPEND_LIMIT_USD,\s*500,?\s*\)/,
    'an unset env var must fall back to a real ceiling, never to unlimited',
  );
});

test('the platform-wide cap still applies when the per-user cap is off', async () => {
  /**
   * The property the whole feature exists for, and the one most likely to be
   * lost to a refactor: production runs with the per-user cap off, so a
   * version that checked the total only as an `else` branch of the personal
   * one would compile, pass every other test, and bound nothing at all.
   */
  const text = await readFile(join(ROOT, 'lib/rate-limit.ts'), 'utf8');
  const gate = text.slice(text.indexOf('export async function checkAiAllowance'));

  // The personal cap must not be able to return early on the allowed path.
  assert.doesNotMatch(
    gate,
    /if\s*\(\s*monthlyCapOff\(\)\s*\)\s*return\s*\{\s*allowed:\s*true/,
    'switching the per-user cap off must not skip the platform-wide one',
  );
  const totalAt = gate.indexOf('reserveTotalAiSpend');
  const capOffAt = gate.indexOf('monthlyCapOff()');
  assert.ok(totalAt > -1, 'the platform-wide reservation is no longer taken');
  assert.ok(
    totalAt > capOffAt,
    'the platform-wide reservation must sit outside the per-user off-switch',
  );
});

test('the per-user allowance is spent before the shared one', async () => {
  /**
   * Neither reservation is ever refunded, so a request denied by the second
   * check has still consumed the first. Personal-first means one looping
   * account exhausts its own allowance rather than nibbling everyone else's
   * ceiling away through requests it was never allowed to make.
   */
  const text = await readFile(join(ROOT, 'lib/rate-limit.ts'), 'utf8');
  const gate = text.slice(text.indexOf('export async function checkAiAllowance'));
  assert.ok(
    gate.indexOf('reserveMonthlyAiSpend') < gate.indexOf('reserveTotalAiSpend'),
    'the personal allowance must be charged before the shared one',
  );
});

test('the two ceilings count against separate keys', async () => {
  // Sharing a key would make the platform ceiling a per-user one with a bigger
  // number, or vice versa — and the bug would be invisible until launch day.
  const text = await readFile(join(ROOT, 'lib/rate-limit.ts'), 'utf8');
  assert.match(text, /`ai-spend:\$\{month\}:\$\{userId\}`/, 'per-user key changed shape');
  assert.match(text, /`ai-spend-total:\$\{month\}`/, 'the platform key must not be per-user');
});

test('the shared-budget refusal does not read as the student’s fault', async () => {
  /**
   * This message fires for someone who has done nothing wrong, and it is the
   * only one of these refusals a student can act on — their own key works
   * immediately and costs the platform nothing. Saying so is the difference
   * between a dead end and a thirty-second fix.
   */
  const text = await readFile(join(ROOT, 'lib/rate-limit.ts'), 'utf8');
  const start = text.indexOf('The shared AI budget');
  assert.ok(start > -1, 'the shared-budget refusal message is gone');
  const message = text.slice(start, start + 400);
  assert.doesNotMatch(message, /\bYour monthly AI allowance\b/);
  assert.match(message, /Account Settings/, 'it must point at the personal-key route');
});
