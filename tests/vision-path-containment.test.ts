import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';

/**
 * Regression tests for the path-traversal fix in lib/vision.ts.
 *
 * The original code did `path.join(process.cwd(), "public", input)` on an
 * attacker-controlled `input`, checking only for a leading "/". Any signed-in
 * student could POST `{"image": "/../../.env"}` to /api/practice/ocr and have
 * the file base64-encoded and shipped to a third-party vision API.
 *
 * lib/vision.ts reaches out to network APIs at import time, so rather than
 * importing it these tests re-express the containment rule it enforces and
 * pin the behaviour for the payloads that matter. `assertContainmentMatches`
 * below must stay in sync with resolveImage().
 */

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** Mirror of the check in lib/vision.ts resolveImage(). */
function isAcceptedUploadPath(input: string, cwd = '/srv/app'): boolean {
  if (!input.startsWith('/')) return false;
  if (input.includes('\0')) return false;

  const uploadRoot = path.resolve(cwd, 'public', 'uploads');
  const resolved = path.resolve(cwd, 'public', input.replace(/^\/+/, ''));

  const relative = path.relative(uploadRoot, resolved);
  const insideUploads =
    relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  if (!insideUploads) return false;

  return IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase());
}

test('rejects traversal out of the uploads directory', () => {
  for (const payload of [
    '/../../.env',
    '/uploads/../../.env',
    '/uploads/../../../etc/passwd',
    '/uploads/../../package.json',
    '/../.env.local',
  ]) {
    assert.equal(isAcceptedUploadPath(payload), false, `should reject ${payload}`);
  }
});

test('rejects files outside uploads even without traversal', () => {
  // These live under public/ but not under public/uploads/.
  assert.equal(isAcceptedUploadPath('/extracted_images/x.png'), false);
  assert.equal(isAcceptedUploadPath('/step-images/y.png'), false);
});

test('rejects non-image extensions inside uploads', () => {
  for (const payload of [
    '/uploads/evil.ts',
    '/uploads/notes.pdf',
    '/uploads/.env',
    '/uploads/script.js',
  ]) {
    assert.equal(isAcceptedUploadPath(payload), false, `should reject ${payload}`);
  }
});

test('rejects null bytes', () => {
  assert.equal(isAcceptedUploadPath('/uploads/ok.png\0.txt'), false);
});

test('still accepts legitimate uploaded images', () => {
  for (const payload of [
    '/uploads/images/ok.png',
    '/uploads/a/b/c.jpeg',
    '/uploads/photo.JPG',
    '/uploads/diagram.webp',
  ]) {
    assert.equal(isAcceptedUploadPath(payload), true, `should accept ${payload}`);
  }
});

test('rejects relative and remote-looking inputs', () => {
  assert.equal(isAcceptedUploadPath('uploads/ok.png'), false);
  assert.equal(isAcceptedUploadPath('../../.env'), false);
});

/**
 * `resolveTrustedImage` widens the allow-list to `bank_assets` so question
 * strips can be transcribed, and nothing else about the rule changes. The
 * separation is the safety property: the untrusted resolver, whose input
 * still arrives from request bodies, must keep refusing that prefix, or
 * widening one call site would have widened every one of them.
 */
function isAcceptedTrustedPath(input: string, cwd = '/srv/app'): boolean {
  if (!input.startsWith('/')) return false;
  if (input.includes('\0')) return false;

  const resolved = path.resolve(cwd, 'public', input.replace(/^\/+/, ''));
  const insideAny = ['uploads', 'bank_assets'].some((prefix) => {
    const root = path.resolve(cwd, 'public', prefix);
    const relative = path.relative(root, resolved);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  if (!insideAny) return false;

  return IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase());
}

test('the trusted resolver reads bank assets, the untrusted one never does', () => {
  const strip = '/bank_assets/ab/cd/abcdef0123456789.png';
  assert.equal(isAcceptedTrustedPath(strip), true);
  assert.equal(isAcceptedUploadPath(strip), false, 'request-supplied paths must not reach bank assets');
});

test('the trusted resolver still refuses traversal and non-images', () => {
  for (const payload of [
    '/bank_assets/../../.env',
    '/bank_assets/../package.json',
    '/bank_assets/strip.ts',
    '/bank_assets/notes.pdf',
    '/papers/0625_w21_qp_63.png',
    '/extracted_images/x.png',
  ]) {
    assert.equal(isAcceptedTrustedPath(payload), false, `should reject ${payload}`);
  }
});

test('the trusted resolver keeps reading ordinary uploads', () => {
  assert.equal(isAcceptedTrustedPath('/uploads/images/ok.png'), true);
});
