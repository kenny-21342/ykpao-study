import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * Tests for the counter semantics of the Postgres-backed limiter in
 * lib/rate-limit.ts.
 *
 * The real module talks to the database, so rather than standing up Postgres
 * these tests pin the decision rule the SQL implements. `windowDecision` below
 * mirrors the `INSERT … ON CONFLICT DO UPDATE` in rateLimit().check() and must
 * stay in sync with it.
 *
 * The property that matters: `count` is the request's position within the
 * window, so the request is allowed exactly when position <= max. Off-by-one
 * here is the difference between allowing 5 and allowing 6 login attempts.
 */

type Row = { count: number; resetAt: number };

/** Mirror of the SQL upsert: returns the new row state for this request. */
function windowDecision(
  existing: Row | undefined,
  now: number,
  intervalMs: number,
): Row {
  if (!existing || existing.resetAt <= now) {
    return { count: 1, resetAt: now + intervalMs };
  }
  return { count: existing.count + 1, resetAt: existing.resetAt };
}

function allowed(row: Row, max: number): boolean {
  return row.count <= max;
}

test('first request in a fresh window is allowed', () => {
  const row = windowDecision(undefined, 1000, 60_000);
  assert.equal(row.count, 1);
  assert.equal(allowed(row, 5), true);
});

test('allows exactly `max` requests per window, then denies', () => {
  const max = 5;
  const intervalMs = 60_000;
  let row: Row | undefined;
  const verdicts: boolean[] = [];

  for (let i = 0; i < 7; i++) {
    row = windowDecision(row, 1000, intervalMs);
    verdicts.push(allowed(row, max));
  }

  // Five allowed, everything after denied — not four, and not six.
  assert.deepEqual(verdicts, [true, true, true, true, true, false, false]);
});

test('the window resets once resetAt has passed', () => {
  const intervalMs = 60_000;
  let row = windowDecision(undefined, 1000, intervalMs);
  for (let i = 0; i < 9; i++) row = windowDecision(row, 1000, intervalMs);
  assert.equal(allowed(row, 5), false);

  // One millisecond past expiry the counter starts over.
  const afterExpiry = windowDecision(row, row.resetAt + 1, intervalMs);
  assert.equal(afterExpiry.count, 1);
  assert.equal(allowed(afterExpiry, 5), true);
});

test('an open window keeps its original resetAt (fixed, not sliding)', () => {
  const intervalMs = 60_000;
  const first = windowDecision(undefined, 1000, intervalMs);
  const second = windowDecision(first, 30_000, intervalMs);
  // A later request must not push the expiry out, or a steady trickle of
  // traffic would keep a blocked key blocked forever.
  assert.equal(second.resetAt, first.resetAt);
});

test('exactly at resetAt the window is treated as expired', () => {
  const intervalMs = 60_000;
  const first = windowDecision(undefined, 1000, intervalMs);
  const atBoundary = windowDecision(first, first.resetAt, intervalMs);
  assert.equal(atBoundary.count, 1);
});
