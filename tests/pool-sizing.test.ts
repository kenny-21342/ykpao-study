import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One pool now, one database, and a connection ceiling that is not ours.
 *
 * There used to be two: `lib/prisma.ts` for queries and `lib/page-pubsub.ts`
 * for the notebook's LISTEN/NOTIFY layer, each per running instance. Left at
 * their defaults -- pg's 10 and a hand-set 20 -- a single warm instance asked
 * for 30 connections, and a serverless deployment runs several.
 *
 * That was invisible against a database allowing hundreds. It was not
 * invisible against a small managed plan, where max_connections can sit near
 * 20: the app does not slow down, it returns `too many clients already` on
 * every route at once, which reads like a total outage rather than a capacity
 * problem.
 *
 * Removing the notebook on 28 Sep 2026 took the second pool with it, which is
 * a real reduction rather than a test being deleted to make it pass. The
 * surviving pool must still be explicitly bounded and configurable. This is a
 * source-level check because the failure only shows up against a real server's
 * limit, which no unit test has.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the query pool sets an explicit, small maximum', async () => {
  const prismaSrc = await readFile(join(root, 'lib/prisma.ts'), 'utf8');

  assert.match(
    prismaSrc,
    /max:\s*poolMax\('DB_POOL_MAX',\s*(\d+)\)/,
    'the Prisma pool no longer bounds itself, so it falls back to pg\'s default of 10',
  );

  const poolDefault = Number(prismaSrc.match(/poolMax\('DB_POOL_MAX',\s*(\d+)\)/)![1]);

  // The smallest managed plans allow around 20 connections in total, and an
  // instance is never the only client -- migrations, a psql session and the
  // next warm instance all want one too.
  assert.ok(
    poolDefault <= 12,
    `the pool defaults to ${poolDefault} connections per instance, ` +
      'which will exhaust a small plan once more than one instance is warm',
  );
});

test('nothing has opened a second pool alongside it', async () => {
  // The point of the original two-pool test, kept now that there is one: a new
  // `new Pool(` anywhere outside lib/prisma.ts is another set of connections
  // per instance, and that is exactly how the count reached 30 before.
  const { readdir } = await import('node:fs/promises');
  const offenders: string[] = [];
  for (const entry of await readdir(join(root, 'lib'))) {
    if (!entry.endsWith('.ts') || entry === 'prisma.ts') continue;
    const src = await readFile(join(root, 'lib', entry), 'utf8');
    // Comments stripped first: lib/env.ts documents this exact hazard in
    // prose ("`new Pool({ connectionString: undefined })` does not throw"),
    // and matching that would fail the test on a file that opens nothing.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (/new\s+Pool\s*\(/.test(code)) offenders.push(`lib/${entry}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `these open their own connection pool: ${offenders.join(', ')}`,
  );
});

test('pool sizes can be raised without a code change', async () => {
  // A bigger plan should not need a deploy to use its capacity.
  for (const [file, envVar] of [
    ['lib/prisma.ts', 'DB_POOL_MAX'],
  ] as const) {
    const src = await readFile(join(root, file), 'utf8');
    // The lookup itself may be dynamic (`process.env[name]`), so check for
    // both halves rather than one literal expression.
    assert.ok(src.includes('process.env'), `${file} reads no environment at all`);
    assert.ok(
      src.includes(envVar),
      `${file} never mentions ${envVar}, so its pool size is baked in`,
    );
  }
});
