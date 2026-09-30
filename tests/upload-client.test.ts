import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUploadResult, uploadFailureMessage } from '../lib/upload-client.ts';
import { RESOURCE_UPLOAD_MAX_BYTES } from '../lib/upload-constants.ts';

/**
 * The bug these guard against: uploading a background image in /account failed
 * with `Unexpected token 'R', "Request En"... is not valid JSON`. A body over
 * the platform's function-request ceiling is rejected at the edge with a
 * `text/plain` "Request Entity Too Large", and the client called .json() on it.
 */

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

test('a plain-text 413 reads as a size problem, not a JSON parse error', async () => {
  const res = textResponse('Request Entity Too LargeFUNCTION_PAYLOAD_TOO_LARGE', 413);
  await assert.rejects(
    () => readUploadResult(res),
    (err: Error) => {
      assert.match(err.message, /too large/i, 'must say the file is too large');
      assert.doesNotMatch(err.message, /JSON|Unexpected token/i, 'must not leak a parser complaint');
      return true;
    },
  );
});

test('the ceiling stays under the 4.5 MB platform limit', () => {
  // Verified against production: a 4 MB body reaches the route, 5 MB is
  // rejected at the edge before the route runs.
  assert.ok(
    RESOURCE_UPLOAD_MAX_BYTES <= 4.5 * 1024 * 1024,
    'a ceiling above the platform limit is unreachable and cannot be enforced in JSON',
  );
});

test('an empty body does not become a parse error', async () => {
  await assert.rejects(
    () => readUploadResult(textResponse('', 500)),
    (err: Error) => {
      assert.doesNotMatch(err.message, /JSON|Unexpected token/i);
      return true;
    },
  );
});

test("a route's own JSON error is preferred over the generic message", async () => {
  const res = new Response(JSON.stringify({ error: 'Unsupported file type' }), {
    status: 400, headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(() => readUploadResult(res), /Unsupported file type/);
});

test('a success response is returned with its metadata', async () => {
  const res = new Response(
    JSON.stringify({ fileUrl: '/uploads/images/a.png', fileName: 'a.png', fileSize: 12, mimeType: 'image/png' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
  const out = await readUploadResult(res);
  assert.equal(out.fileUrl, '/uploads/images/a.png');
  assert.equal(out.fileName, 'a.png');
  assert.equal(out.mimeType, 'image/png');
});

test('a 200 with no fileUrl is a failure, not a silent success', async () => {
  const res = new Response(JSON.stringify({ success: true }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(() => readUploadResult(res));
});

test('every mapped status yields a message with no parser wording', () => {
  for (const status of [413, 401, 403, 429, 500, 418]) {
    const msg = uploadFailureMessage(status);
    assert.ok(msg.length > 0);
    assert.doesNotMatch(msg, /JSON|undefined/);
  }
});
