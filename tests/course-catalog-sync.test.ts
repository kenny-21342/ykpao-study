import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The course catalogue is seeded once per process, not once per request.
 *
 * `ensureCourseCatalog()` ran its full sync on every call: 47 course upserts
 * and 47 scope upserts, sequentially, against Neon. The pre-launch sweep on
 * 30 Aug 2026 measured /api/onboarding at 4.1s and /api/me/courses at 4.3s,
 * which is almost entirely that -- and onboarding is the first request a new
 * student makes.
 *
 * `COURSE_CATALOG` is a compile-time constant, so it can only change when the
 * code does, which means a new process anyway.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = 'lib/course-catalog.ts';

async function source(relative: string): Promise<string> {
  return readFile(join(root, relative), 'utf8');
}

test('the sync is memoised across calls', async () => {
  const src = await source(CATALOG);
  assert.match(src, /let catalogSync: Promise<void> \| null = null;/);
  assert.match(
    src,
    /catalogSync \?\?= syncCourseCatalog\(\)/,
    'a second call must reuse the first promise rather than re-running the sync',
  );
});

test('a failed sync can be retried', async () => {
  const src = await source(CATALOG);
  assert.match(
    src,
    /\.catch\(\(error\) => \{\s*\n\s*catalogSync = null;\s*\n\s*throw error;/,
    'a transient database error must not leave the catalogue unsynced for the life of the process',
  );
});

test('entries are synced with bounded concurrency, not one at a time', async () => {
  const src = await source(CATALOG);
  assert.match(src, /const CONCURRENCY = \d+;/);
  assert.match(src, /await Promise\.all\(Array\.from\(\{ length: CONCURRENCY \}, worker\)\)/);
  const concurrency = Number(/const CONCURRENCY = (\d+);/.exec(src)?.[1]);
  assert.ok(
    concurrency > 1 && concurrency <= 16,
    'concurrency should relieve the serial round trips without flooding a 0.25 CU instance',
  );
});

test('callers still await the guard, not the raw sync', async () => {
  for (const file of ['app/api/onboarding/route.ts', 'app/api/me/courses/route.ts']) {
    const src = await source(file);
    assert.match(src, /await ensureCourseCatalog\(\)/, `${file} must call the guarded entry point`);
    assert.doesNotMatch(src, /syncCourseCatalog/, `${file} must not bypass the guard`);
  }
});
