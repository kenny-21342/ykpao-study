import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A tab nobody is looking at must not keep the database awake.
 *
 * On 19 Sep 2026 production went down for the rest of the month. The cause
 * was not load: it was `NotificationBell` running two timers behind any
 * signed-in session -- a server-side `notification.count()` every 15s inside
 * the SSE stream, and a 30s client poll of `/api/notifications` -- neither of
 * which stopped when the tab was hidden. Serverless Postgres suspends its
 * compute after ~5 minutes of inactivity, so one forgotten tab meant it never
 * suspended once. It stayed awake for ten days, spent the month's whole
 * compute allowance with eleven days left, and every request then failed with
 * a quota error.
 *
 * These assertions are worth pinning because the failure is invisible in
 * development and in review. A fixed-interval poll is the obvious way to
 * write this code, it works perfectly, and the bill arrives weeks later.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function appSources(): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        await walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  }
  await walk(join(root, 'app'));
  return out;
}

test('the notifications stream backs off instead of polling on a fixed interval', async () => {
  const src = await readFile(
    join(root, 'app/api/notifications/stream/route.ts'),
    'utf8',
  );

  assert.ok(
    !/setInterval\(\s*poll/.test(src),
    'the unread poll is back on setInterval, which cannot back off: a silent ' +
      'stream will query the database at a fixed rate for as long as it is open',
  );
  assert.match(
    src,
    /POLL_MAX_MS/,
    'the unread poll has no ceiling constant; it must back off to a bounded ' +
      'maximum while the count is unchanged',
  );
});

test('the notification bell stops all timers when its tab goes quiet', async () => {
  const src = await readFile(join(root, 'app/components/NotificationBell.tsx'), 'utf8');

  assert.match(src, /useTabActive/, 'NotificationBell no longer gates on tab activity');

  // Both loops, not just one: the SSE stream and the fallback poll each
  // reached the database on their own, and leaving either ungated leaves the
  // compute pinned exactly as before.
  const guards = src.match(/if \(!isAuthenticated \|\| !tabActive\) return;/g) ?? [];
  assert.equal(
    guards.length,
    2,
    `expected both the SSE effect and the fallback poll to bail when the tab ` +
      `is inactive, found ${guards.length} such guard(s)`,
  );
});

test('no other signed-in component polls the server on an ungated timer', async () => {
  // A new always-on timer anywhere in the app shell reopens the same hole.
  // Anything on a timer that talks to the server has to gate on tab activity
  // (or justify itself by being added to this list).
  const allowed = new Set([
    join(root, 'app/components/NotificationBell.tsx'),
    // Presence is only mounted while a notebook page is actually open, and
    // its whole purpose is telling other people you are there.
    join(root, 'app/components/usePageCollaboration.ts'),
    // Mock-exam autosave. Its 60s timer cannot be gated on tab activity --
    // losing a student's answers because they alt-tabbed is far worse than
    // any database bill -- so it is made harmless a different way: the save
    // is skipped when the answer sheet is byte-identical to the last one the
    // server acknowledged. An idle exam therefore issues no writes at all.
    // Asserted directly below.
    join(root, 'app/components/MockExams.tsx'),
  ]);

  const offenders: string[] = [];
  for (const file of await appSources()) {
    if (allowed.has(file)) continue;
    const src = await readFile(file, 'utf8');
    const polls = /setInterval\(/.test(src) && /fetch\(|EventSource\(/.test(src);
    if (polls && !/useTabActive/.test(src)) {
      offenders.push(file.slice(root.length + 1));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these files poll the server on a timer without gating on tab activity:\n' +
      offenders.join('\n'),
  );
});

test('mock-exam autosave skips writes when nothing changed', async () => {
  const src = await readFile(join(root, 'app/components/MockExams.tsx'), 'utf8');

  assert.match(
    src,
    /if \(payload === lastSavedPayload\.current\) return;/,
    'autosave no longer short-circuits an unchanged answer sheet, so an open ' +
      'but untouched exam writes to the database once a minute forever',
  );
  assert.match(
    src,
    /lastSavedPayload\.current = payload;/,
    'the saved-payload marker is never updated, so the short-circuit above ' +
      'can never fire',
  );
});

test('the default health probe does not touch the database', async () => {
  // The other tests here stop *clients* pinning the compute awake. This one
  // stops the server doing it to itself. /api/health is unauthenticated and
  // the single most requested path on the site -- 90 hits in 42 minutes on
  // 28 Sep 2026, one every 28 seconds -- so a `SELECT 1` on the default path
  // means the compute never reaches the five minutes of idle it needs to
  // suspend. The database check still exists behind `?deep=1`, which is asked
  // deliberately rather than on a timer.
  const src = await readFile(join(root, 'app/api/health/route.ts'), 'utf8');

  assert.ok(
    /deep/.test(src),
    'the health route no longer distinguishes liveness from readiness, so the ' +
      'uptime probe is back to querying the database twice a minute',
  );

  // The shallow branch must return before anything reaches Postgres.
  const shallowEnd = src.indexOf('let databaseOk');
  assert.ok(shallowEnd > 0, 'expected a readiness branch after the liveness one');
  const shallow = src.slice(0, shallowEnd);
  assert.ok(
    !/prisma\./.test(shallow),
    'the liveness branch of /api/health reaches Prisma before returning; it ' +
      'must answer without a database round-trip',
  );
});
