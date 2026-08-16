import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  encodeKeyPath,
  presignUrl,
  signRequest,
  uriEncode,
  EMPTY_BODY_SHA256,
} from '../lib/storage/sigv4.ts';

/**
 * SigV4 is signed-and-rejected-remotely: a mistake produces a signature that
 * looks fine locally and fails only against the real bucket, with an opaque
 * 403. So the algorithm is pinned against AWS's own published test vector.
 */

const AWS_TEST_CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
};

test('signRequest reproduces the AWS SigV4 test-suite signature', () => {
  // From the AWS "aws-sig-v4-test-suite" case `get-vanilla`:
  //   GET / with only the host and x-amz-date headers signed.
  const headers = signRequest({
    method: 'GET',
    url: new URL('https://example.amazonaws.com/'),
    headers: {},
    payloadHash: EMPTY_BODY_SHA256,
    credentials: AWS_TEST_CREDENTIALS,
    now: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
  });

  assert.equal(headers['x-amz-date'], '20150830T123600Z');
  assert.equal(
    headers.Authorization,
    'AWS4-HMAC-SHA256 ' +
      'Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
      'SignedHeaders=host;x-amz-date, ' +
      'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
  );
});

test('the s3 service adds the payload-hash header, others do not', () => {
  // S3 requires x-amz-content-sha256 and signs it; including it for the
  // generic test-suite service above would have broken that vector.
  const s3 = signRequest({
    method: 'GET',
    url: new URL('https://bucket.s3.us-east-1.amazonaws.com/k'),
    headers: {},
    payloadHash: EMPTY_BODY_SHA256,
    credentials: { ...AWS_TEST_CREDENTIALS, service: 's3' },
  });
  assert.equal(s3['x-amz-content-sha256'], EMPTY_BODY_SHA256);
  assert.match(s3.Authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
});

test('uriEncode escapes the characters encodeURIComponent leaves alone', () => {
  // These five are the whole reason a custom encoder exists.
  assert.equal(uriEncode("!'()*"), '%21%27%28%29%2A');
  assert.equal(uriEncode('a b'), 'a%20b');
  assert.equal(uriEncode('/'), '%2F');
});

test('encodeKeyPath escapes segments but keeps the separators', () => {
  assert.equal(
    encodeKeyPath('papers/my raw pdfs/9702_s24_qp_21.pdf'),
    'papers/my%20raw%20pdfs/9702_s24_qp_21.pdf'
  );
  assert.equal(encodeKeyPath("papers/o'level/x.pdf"), 'papers/o%27level/x.pdf');
});

test('presignUrl carries every required query parameter', () => {
  const url = presignUrl({
    method: 'GET',
    url: new URL('https://bucket.s3.eu-west-1.amazonaws.com/papers/a.pdf'),
    expiresInSeconds: 900,
    credentials: { ...AWS_TEST_CREDENTIALS, region: 'eu-west-1', service: 's3' },
    now: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
  });

  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(parsed.searchParams.get('X-Amz-Expires'), '900');
  assert.equal(parsed.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.equal(parsed.searchParams.get('X-Amz-Date'), '20150830T123600Z');
  assert.equal(
    parsed.searchParams.get('X-Amz-Credential'),
    'AKIDEXAMPLE/20150830/eu-west-1/s3/aws4_request'
  );
  assert.match(parsed.searchParams.get('X-Amz-Signature') ?? '', /^[0-9a-f]{64}$/);
});

test('presignUrl signs response-header overrides', () => {
  // `response-content-disposition` is part of the canonical query string, so a
  // URL signed without it and then handed the parameter is rejected. Two URLs
  // differing only in that parameter must therefore have different signatures.
  const base = {
    method: 'GET' as const,
    url: new URL('https://bucket.s3.eu-west-1.amazonaws.com/papers/a.pdf'),
    expiresInSeconds: 900,
    credentials: { ...AWS_TEST_CREDENTIALS, region: 'eu-west-1', service: 's3' },
    now: new Date(Date.UTC(2015, 7, 30, 12, 36, 0)),
  };

  const plain = new URL(presignUrl(base));
  const withDisposition = new URL(
    presignUrl({
      ...base,
      extraQuery: { 'response-content-disposition': 'attachment; filename="a.pdf"' },
    })
  );

  assert.equal(
    withDisposition.searchParams.get('response-content-disposition'),
    'attachment; filename="a.pdf"'
  );
  assert.notEqual(
    plain.searchParams.get('X-Amz-Signature'),
    withDisposition.searchParams.get('X-Amz-Signature')
  );
});

test('a session token is signed into both header and presigned forms', () => {
  const credentials = { ...AWS_TEST_CREDENTIALS, sessionToken: 'FQoDYXdzE' };

  const headers = signRequest({
    method: 'GET',
    url: new URL('https://example.amazonaws.com/'),
    headers: {},
    payloadHash: EMPTY_BODY_SHA256,
    credentials,
  });
  assert.equal(headers['x-amz-security-token'], 'FQoDYXdzE');
  assert.match(headers.Authorization, /x-amz-security-token/);

  const presigned = new URL(
    presignUrl({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/k'),
      expiresInSeconds: 60,
      credentials,
    })
  );
  assert.equal(presigned.searchParams.get('X-Amz-Security-Token'), 'FQoDYXdzE');
});
