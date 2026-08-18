import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  serveProtectedAsset,
  type AssetPrefix,
} from '../lib/storage/protected-asset.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every HTML injection site has a sanitization or generated-output boundary', async () => {
  const cases: Array<[string, RegExp]> = [
    ['app/announcements/page.tsx', /sanitizeHtml\(a\.body\)/],
    ['app/components/AnnouncementBanner.tsx', /sanitizeHtml\(a\.body\)/],
    ['app/components/CompetitionVault.tsx', /sanitizeHtml\(selected\.body\)/],
    ['app/components/FormattedMessage.tsx', /sanitizeHtml\(renderMarkdownWithMath/],
    ['app/components/ResourceLibrary.tsx', /sanitizeHtml\(note\.content\)/],
    ['app/components/RichContent.tsx', /sanitizeHtml\(root\.innerHTML\)/],
  ];

  for (const [relative, boundary] of cases) {
    const source = await readFile(join(root, relative), 'utf8');
    assert.match(source, /dangerouslySetInnerHTML/, `${relative} is no longer an audited sink`);
    assert.match(source, boundary, `${relative} must keep its output boundary`);
  }
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
  assert.match(adminLayout, /requireAdmin\(\)/);
});
