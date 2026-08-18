import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertSafeKey,
  isSafeKey,
  keyFromPublicPath,
  paperKey,
  publicPathFromKey,
} from '../lib/storage/keys.ts';
import { LocalObjectStore } from '../lib/storage/local-store.ts';

/**
 * Key validation is the containment boundary for the whole storage layer: the
 * local driver joins these onto real directories, so a key that escapes its
 * prefix is an arbitrary file read — and the paths come from the database and
 * from request bodies.
 */

const TRAVERSALS = [
  '../secret',
  'uploads/../../.env',
  'uploads/./../../etc/passwd',
  '/etc/passwd',
  'uploads//double',
  'uploads\\windows',
  'uploads/a\0b',
];

test('assertSafeKey rejects traversal and malformed keys', () => {
  for (const key of TRAVERSALS) {
    assert.throws(() => assertSafeKey(key), /Invalid storage key/, `accepted: ${key}`);
    assert.equal(isSafeKey(key), false, `isSafeKey accepted: ${key}`);
  }
  assert.throws(() => assertSafeKey(''), /Invalid storage key/);
  assert.throws(() => assertSafeKey('a'.repeat(1025)), /too long/);
});

test('assertSafeKey accepts ordinary keys', () => {
  for (const key of [
    'uploads/images/9f6d.png',
    'papers/my_raw_pdfs/igcse/physics-0625/0625_w21_qp_63.pdf',
    'extracted_images/9702_s2024_2v1_q3.png',
    'extracted_images/' + 'a'.repeat(64) + '.png',
  ]) {
    assert.equal(assertSafeKey(key), key);
  }
});

test('paperKey strips the legacy pdf_extraction/ prefix', () => {
  assert.equal(paperKey('my_raw_pdfs/a/b.pdf'), 'papers/my_raw_pdfs/a/b.pdf');
  assert.equal(paperKey('pdf_extraction/my_raw_pdfs/a/b.pdf'), 'papers/my_raw_pdfs/a/b.pdf');
  assert.equal(paperKey('./my_raw_pdfs/a/b.pdf'), 'papers/my_raw_pdfs/a/b.pdf');
  // Windows-style separators appear in some older rows.
  assert.equal(paperKey('my_raw_pdfs\\a\\b.pdf'), 'papers/my_raw_pdfs/a/b.pdf');
});

test('paperKey returns null rather than throwing on a hostile stored path', () => {
  // These come from the database, so a bad row must degrade to "unavailable",
  // not a 500.
  for (const stored of ['../../.env', '/etc/passwd', '', 'a/../../../b', 'x\0y']) {
    assert.equal(paperKey(stored), null, `accepted: ${stored}`);
  }
});

test('keyFromPublicPath decodes before validating', () => {
  assert.equal(keyFromPublicPath('/uploads/images/a.png'), 'uploads/images/a.png');
  assert.equal(keyFromPublicPath('/extracted_images/x.png'), 'extracted_images/x.png');
  assert.equal(keyFromPublicPath('/uploads/files/a.pdf?v=2'), 'uploads/files/a.pdf');

  // %2e%2e decodes to ".."; validating before decoding would let this through.
  assert.equal(keyFromPublicPath('/uploads/%2e%2e/%2e%2e/.env'), null);
  assert.equal(keyFromPublicPath('/uploads/..%2f..%2f.env'), null);
  // Prefixes outside the storage-backed set are refused outright.
  assert.equal(keyFromPublicPath('/etc/passwd'), null);
  assert.equal(keyFromPublicPath('/_next/static/chunk.js'), null);
});

test('publicPathFromKey round-trips', () => {
  const key = 'extracted_images/9702_s2024_2v1_q3.png';
  assert.equal(keyFromPublicPath(publicPathFromKey(key)), key);
});

test('LocalObjectStore confines reads to the mapped directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'smart-edu-storage-'));
  await mkdir(path.join(root, 'public', 'uploads', 'images'), { recursive: true });
  await writeFile(path.join(root, 'secret.txt'), 'do not serve me');

  const store = new LocalObjectStore(root);
  await store.put('uploads/images/a.png', Buffer.from('png-bytes'));

  const stored = await store.get('uploads/images/a.png');
  assert.equal(stored?.bytes.toString(), 'png-bytes');
  assert.equal(stored?.contentType, 'image/png');
  assert.equal((await store.head('uploads/images/a.png'))?.size, 9);

  // Missing keys are null, not an exception.
  assert.equal(await store.get('uploads/images/missing.png'), null);
  assert.equal(await store.head('uploads/images/missing.png'), null);

  // Escaping the prefix throws before any filesystem access.
  await assert.rejects(() => store.get('uploads/../../secret.txt'), /Invalid storage key/);
  // A key with no mapped directory is refused too.
  await assert.rejects(() => store.get('nowhere/a.png'), /No local directory is mapped/);
});

test('LocalObjectStore.list matches a partial filename prefix', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'smart-edu-storage-'));
  const dir = path.join(root, 'public', 'extracted_images');
  await mkdir(dir, { recursive: true });
  for (const name of ['9702_s24_q1.png', '9702_s24_q2.png', '0625_w21_q1.png']) {
    await writeFile(path.join(dir, name), 'x');
  }

  const store = new LocalObjectStore(root);
  assert.deepEqual(await store.list('extracted_images/9702_s24'), [
    'extracted_images/9702_s24_q1.png',
    'extracted_images/9702_s24_q2.png',
  ]);
  assert.deepEqual(await store.list('extracted_images/nope'), []);
  assert.equal((await store.list('extracted_images/9702_s24', 1)).length, 1);

  // A missing directory means nothing extracted yet, not an error.
  const empty = new LocalObjectStore(await mkdtemp(path.join(tmpdir(), 'smart-edu-empty-')));
  assert.deepEqual(await empty.list('extracted_images/x'), []);
});

test('LocalObjectStore cannot sign URLs, so callers must stream', async () => {
  const store = new LocalObjectStore(await mkdtemp(path.join(tmpdir(), 'smart-edu-sign-')));
  assert.equal(await store.signedGetUrl(), null);
});
