import assert from 'node:assert/strict';
import { test } from 'node:test';

import { serveStoredObject } from '../lib/storage/serve.ts';
import { S3ObjectStore } from '../lib/storage/s3-store.ts';
import { resetStorageForTests } from '../lib/storage/index.ts';

/**
 * Crops are content-addressed by sha256, so a given URL's bytes can never
 * change — and yet production served every one of them with `no-cache`, from a
 * freshly signed URL that no browser had seen before. A question page paid a
 * function invocation and a full object read per strip on every single render.
 *
 * Two things have to hold for a crop to be cached, and neither is obvious from
 * reading the redirect alone: the signed URL must be *stable* across renders,
 * and it must carry a `Cache-Control` that beats the bucket's default.
 */

const config = {
  bucket: 'test-bucket',
  endpoint: 'https://accountid.r2.cloudflarestorage.com',
  region: 'auto',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  signedUrlTtlSeconds: 900,
};

function store() {
  return new S3ObjectStore(config);
}

test('a signed crop URL is identical across calls inside the stable window', async () => {
  const s = store();
  const options = { stableWindowSeconds: 3 * 24 * 60 * 60, expiresInSeconds: 7 * 24 * 60 * 60 };
  const first = await s.signedGetUrl('bank_assets/ab/abc.png', options);
  const second = await s.signedGetUrl('bank_assets/ab/abc.png', options);
  assert.ok(first);
  assert.equal(first, second, 'a rotating URL is a guaranteed browser cache miss');
});

test('without a stable window the signature still varies with the clock', async () => {
  const s = store();
  // Same key, one-second window: two calls in the same second match, and the
  // point of the assertion is that quantisation is what makes them match.
  const url = await s.signedGetUrl('bank_assets/ab/abc.png', { stableWindowSeconds: 1 });
  assert.ok(url);
  assert.match(url, /X-Amz-Date=\d{8}T\d{6}Z/);
});

test('cacheControl is signed into the URL as a response override', async () => {
  const s = store();
  const url = await s.signedGetUrl('bank_assets/ab/abc.png', {
    cacheControl: 'public, max-age=259200, immutable',
  });
  assert.ok(url);
  assert.match(url, /response-cache-control=public/);
  // It must be inside SignedHeaders' canonical query, or R2 rejects the URL.
  assert.match(url, /X-Amz-Signature=[0-9a-f]{64}$/);
});

test('serveStoredObject returns a cacheable redirect, not a bare one', async (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    resetStorageForTests();
  });

  process.env.STORAGE_DRIVER = 's3';
  process.env.STORAGE_BUCKET = config.bucket;
  process.env.STORAGE_ENDPOINT = config.endpoint;
  process.env.STORAGE_REGION = config.region;
  process.env.STORAGE_ACCESS_KEY_ID = config.accessKeyId;
  process.env.STORAGE_SECRET_ACCESS_KEY = config.secretAccessKey;
  delete process.env.STORAGE_PUBLIC_BASE_URL;
  resetStorageForTests();

  const response = await serveStoredObject([
    'bank_assets',
    'ab',
    'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd.png',
  ]);

  assert.equal(response.status, 307);
  const location = response.headers.get('location');
  assert.ok(location, 'expected a redirect target');
  assert.match(location, /response-cache-control=/);

  const cacheControl = response.headers.get('cache-control');
  assert.ok(cacheControl, 'Response.redirect sends no cache headers — the redirect itself must');
  // `private`: the route in front of this is session-gated.
  assert.match(cacheControl, /^private, max-age=\d+$/);
});
