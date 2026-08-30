import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The question catalogue requires a session.
 *
 * Both routes called `getSessionUser()` and then used the result only to
 * *scope* the query. An anonymous request therefore fell outside `enrolled`
 * scope -- which means "every subject" -- and could page through all 65,776
 * published questions, or pull 45KB of subject catalogue from
 * `?action=filters`, without an account. Being signed out granted broader
 * access than being signed in.
 *
 * Source-level, because the failure is someone reinstating the old shape:
 * reading the session for scoping and forgetting to refuse without one. That
 * reads as perfectly ordinary code and no test of a signed-in caller notices.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const GATED = ['app/api/bank/questions/route.ts', 'app/api/questions/route.ts'];

async function source(relative: string): Promise<string> {
  return readFile(join(root, relative), 'utf8');
}

test('the catalogue routes refuse a caller with no session', async () => {
  for (const file of GATED) {
    const src = await source(file);
    assert.match(
      src,
      /if \(!user\) \{\s*\n\s*return NextResponse\.json\(/,
      `${file} must refuse when there is no session`,
    );
    assert.match(src, /status: 401/, `${file} must answer 401`);
  }
});

test('the refusal happens before any scoping', async () => {
  for (const file of GATED) {
    const src = await source(file);
    const gate = src.indexOf('if (!user)');
    const scope = src.indexOf('resolveCourseScope(');
    assert.notEqual(gate, -1, `${file} must have a gate`);
    assert.notEqual(scope, -1, `${file} must still scope`);
    assert.ok(
      gate < scope,
      `${file} must refuse before resolving scope -- an anonymous caller resolves to "every subject"`,
    );
  }
});

test('the refusal tells the reader what to do about it', async () => {
  for (const file of GATED) {
    const src = await source(file);
    assert.match(
      src,
      /error: 'Sign in to browse/,
      `${file} should say "sign in", not "Unauthorized"`,
    );
  }
});

test('Practice does not fetch the bank before a session exists', async () => {
  const src = await source('app/components/BankPractice.tsx');
  assert.match(
    src,
    /if \(sessionStatus !== 'authenticated'\) return;/,
    'the list effect must not fire a 401 on first paint',
  );
  assert.match(
    src,
    /sessionStatus === 'unauthenticated'/,
    'a signed-out student should get an explanation, not a bare error string',
  );
});
