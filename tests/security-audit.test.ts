import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  serveProtectedAsset,
  type AssetPrefix,
} from '../lib/storage/protected-asset.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/**
 * Injection sites whose boundary is something other than `sanitizeHtml` — a
 * value the app generated itself rather than untrusted stored markup. Adding
 * an entry here is a deliberate audit decision, so the list is deliberately
 * awkward to extend: it must name the file and the boundary that replaces
 * sanitisation.
 */
const GENERATED_OUTPUT_SINKS: Array<[string, RegExp]> = [];

/**
 * Discovery-based rather than a fixed list. The previous version enumerated
 * the sinks by hand, which meant a NEW unsanitised `dangerouslySetInnerHTML`
 * anywhere in `app/` was invisible to this suite — and deleting an audited
 * file silently shrank the audit instead of failing.
 */
test('every HTML injection site has a sanitization or generated-output boundary', async () => {
  const boundaries = new Map(GENERATED_OUTPUT_SINKS);
  const sinks: string[] = [];

  for (const file of await sourceFiles(join(root, 'app'))) {
    const source = await readFile(file, 'utf8');
    if (!source.includes('dangerouslySetInnerHTML')) continue;

    const relative = file.slice(root.length + 1);
    sinks.push(relative);

    const boundary = boundaries.get(relative) ?? /sanitizeHtml\(/;
    assert.match(source, boundary, `${relative} must keep its output boundary`);
  }

  // A sink count of zero would pass every assertion above vacuously.
  assert.ok(sinks.length > 0, 'found no dangerouslySetInnerHTML sites — the walk is broken');

  const stale = [...boundaries.keys()].filter((file) => !sinks.includes(file));
  assert.deepEqual(stale, [], `exempted files that are no longer sinks: ${stale.join(', ')}`);
});

/**
 * The three historical asset prefixes. Their URLs live in thousands of DB rows
 * and in stored note HTML, so the paths themselves must never change — only
 * the access check in front of them.
 */
const ASSET_ROUTES: Array<[AssetPrefix, string]> = [
  ['uploads', 'app/uploads/[...path]/route.ts'],
  ['extracted_images', 'app/extracted_images/[...path]/route.ts'],
  ['step-images', 'app/step-images/[...path]/route.ts'],
];

test('every asset prefix denies an unauthenticated request', async () => {
  for (const [prefix] of ASSET_ROUTES) {
    for (const session of [null, {}, { user: null }, { user: {} }, { user: { id: null } }]) {
      let served = false;
      const response = await serveProtectedAsset(prefix, ['secret.png'], {
        getSession: async () => session as never,
        serve: async () => {
          served = true;
          return new Response('bytes');
        },
      });

      assert.equal(response.status, 401, `${prefix} must reject ${JSON.stringify(session)}`);
      assert.equal(served, false, `${prefix} must not touch storage without a session`);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
  }
});

test('a failing session lookup fails closed rather than open', async () => {
  for (const [prefix] of ASSET_ROUTES) {
    let served = false;
    const response = await serveProtectedAsset(prefix, ['secret.png'], {
      getSession: async () => {
        throw new Error('NEXTAUTH_SECRET missing');
      },
      serve: async () => {
        served = true;
        return new Response('bytes');
      },
    });

    assert.equal(response.status, 401, `${prefix} must deny when the session backend throws`);
    assert.equal(served, false);
  }
});

test('an authenticated request reaches storage under its unchanged prefix', async () => {
  for (const [prefix] of ASSET_ROUTES) {
    let segments: string[] | null = null;
    const response = await serveProtectedAsset(prefix, ['nested', 'file.png'], {
      getSession: async () => ({ user: { id: 'user-1' } }),
      serve: async (received) => {
        segments = received;
        return new Response('bytes', { status: 200 });
      },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(segments, [prefix, 'nested', 'file.png']);
  }
});

test('each asset route wires the session gate ahead of object storage', async () => {
  for (const [, relative] of ASSET_ROUTES) {
    const source = await readFile(join(root, relative), 'utf8');
    assert.match(source, /getServerSession\(authOptions\)/, `${relative} must read the session`);
    assert.match(source, /serveProtectedAsset\(/, `${relative} must go through the gate`);
    assert.doesNotMatch(
      source,
      /serveStoredObject/,
      `${relative} must not reach object storage directly`
    );
  }
});

test('the admin route segment is protected server-side', async () => {
  const adminLayout = await readFile(join(root, 'app/admin/layout.tsx'), 'utf8');
  assert.match(adminLayout, /requireAdmin\(\)/, 'app/admin/layout.tsx must gate the segment');

  // The layout only covers the pages. Every admin API route is reachable
  // directly, so each one has to make the check itself.
  const routes = (await sourceFiles(join(root, 'app/api/admin'))).filter((file) =>
    file.endsWith('route.ts'),
  );
  assert.ok(routes.length > 0, 'found no admin API routes — the walk is broken');

  for (const file of routes) {
    const relative = file.slice(root.length + 1);
    const source = await readFile(file, 'utf8');
    assert.match(source, /requireAdmin\(\)/, `${relative} must call requireAdmin()`);
    assert.match(source, /status: 403/, `${relative} must refuse a non-admin with 403`);
  }
});
