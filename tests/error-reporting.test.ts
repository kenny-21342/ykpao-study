import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fingerprintOf, redactSecrets } from '../lib/error-redaction.ts';

/**
 * Errors quote whatever failed, and what failed is often a URL with a key in
 * it. Every admin can read this table, so redaction has to happen on the way
 * in -- a leaked credential cannot be un-stored.
 */

test('redacts bearer tokens', () => {
  assert.equal(
    redactSecrets('Request failed with Authorization: Bearer sk-abc123DEF456ghi'),
    'Request failed with Authorization: Bearer [redacted]',
  );
});

test('redacts bare provider keys', () => {
  assert.equal(redactSecrets('bad key sk-proj-AAAABBBBCCCC'), 'bad key sk-[redacted]');
});

test('redacts database connection strings', () => {
  assert.equal(
    redactSecrets('connect ECONNREFUSED postgresql://user:hunter2@db.neon.tech/main'),
    'connect ECONNREFUSED postgresql://[redacted]',
  );
});

test('redacts credentials carried in query strings', () => {
  assert.equal(
    redactSecrets('GET https://api.example/v1?model=x&api_key=SECRETVALUE&n=1 failed'),
    'GET https://api.example/v1?model=x&api_key=[redacted]&n=1 failed',
  );
  assert.equal(
    redactSecrets('https://bucket.r2.cloudflarestorage.com/k?X-Amz-Signature=deadbeefcafe'),
    'https://bucket.r2.cloudflarestorage.com/k?X-Amz-Signature=[redacted]',
  );
});

test('redacts a SigV4 credential header', () => {
  assert.equal(
    redactSecrets('AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260823/auto/s3/aws4_request, Signed'),
    'AWS4-HMAC-SHA256 Credential=[redacted], Signed',
  );
});

test('leaves an ordinary message untouched', () => {
  const msg = 'Cannot read properties of undefined (reading "items")';
  assert.equal(redactSecrets(msg), msg);
});

test('one bug fingerprints the same across occurrences', () => {
  // Ids and counts differ per occurrence; the bug does not.
  const a = fingerprintOf('Paper 2576 not found after 3 tries', '/api/papers/[id]');
  const b = fingerprintOf('Paper 9981 not found after 7 tries', '/api/papers/[id]');
  assert.equal(a, b);
});

test('the same message on different routes is a different bug', () => {
  assert.notEqual(
    fingerprintOf('Unauthorized', '/api/papers/[id]'),
    fingerprintOf('Unauthorized', '/api/notes/[id]'),
  );
});
