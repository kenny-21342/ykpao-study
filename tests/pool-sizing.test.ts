import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Two pools, one database, and a connection ceiling that is not ours.
 *
 * `lib/prisma.ts` opens a pool for queries and `lib/page-pubsub.ts` opens a
 * second one for LISTEN/NOTIFY, each per running instance. Left at their
 * defaults -- pg's 10 and a hand-set 20 -- a single warm instance asks for
 * 30 connections, and a serverless deployment runs several.
 *
 * That was invisible against a database allowing hundreds. It is not
 * invisible against a small managed plan, where max_connections can sit near
 * 20: the app does not slow down, it returns `too many clients already` on
 * every route simultaneously, which reads like a total outage rather than a
 * capacity problem.
 *
 * So both pools must stay explicitly bounded and configurable. This is a
 * source-level check because the failure only shows up against a real
 * server's limit, which no unit test has.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('both pools set an explicit, small maximum', async () => {
  const prismaSrc = await readFile(join(root, 'lib/prisma.ts'), 'utf8');
  const pubsubSrc = await readFile(join(root, 'lib/page-pubsub.ts'), 'utf8');

  assert.match(
    prismaSrc,
    /max:\s*poolMax\('DB_POOL_MAX',\s*(\d+)\)/,
    'the Prisma pool no longer bounds itself, so it falls back to pg\'s default of 10',
  );
  assert.match(
    pubsubSrc,
    /max:\s*pubsubPoolMax\(\)/,
    'the LISTEN/NOTIFY pool no longer bounds itself',
  );

  const defaults = [
    Number(prismaSrc.match(/poolMax\('DB_POOL_MAX',\s*(\d+)\)/)![1]),
    Number(pubsubSrc.match(/PUBSUB_POOL_MAX[\s\S]{0,200}?:\s*(\d+);/)![1]),
  ];
  const total = defaults.reduce((a, b) => a + b, 0);

  // The smallest managed plans allow around 20 connections in total, and an
  // instance is never the only client -- migrations, a psql session and the
  // next warm instance all want one too.
  assert.ok(
    total <= 12,
    `the two pools default to ${total} connections per instance (${defaults.join(' + ')}), ` +
      'which will exhaust a small plan once more than one instance is warm',
  );
});

test('pool sizes can be raised without a code change', async () => {
  // A bigger plan should not need a deploy to use its capacity.
  for (const [file, envVar] of [
    ['lib/prisma.ts', 'DB_POOL_MAX'],
    ['lib/page-pubsub.ts', 'PUBSUB_POOL_MAX'],
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
