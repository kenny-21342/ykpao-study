import { createHash, createHmac } from 'node:crypto';

/**
 * Minimal AWS Signature Version 4 signing for S3-compatible object storage.
 *
 * Only the two things this app needs are implemented: signing a request with an
 * `Authorization` header (used for PUT/GET/HEAD/LIST from the server) and
 * producing a presigned query-string URL (used to hand a browser a temporary
 * direct-download link for a past paper).
 *
 * This is deliberately dependency-free. `@aws-sdk/client-s3` pulls in tens of
 * megabytes to do what amounts to a handful of HMACs, and it would be dead
 * weight in every serverless bundle. SigV4 is a fixed, published algorithm and
 * the implementation below is checked against AWS's own test vectors in
 * `tests/sigv4.test.ts`.
 */

export type SigV4Credentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region: string;
  service: string;
};

const ALGORITHM = 'AWS4-HMAC-SHA256';
/** Payload hash used when the body is not signed (presigned URLs). */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
/** sha256 of the empty string — the payload hash for a body-less request. */
export const EMPTY_BODY_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * RFC 3986 percent-encoding.
 *
 * `encodeURIComponent` leaves `!'()*` alone, but SigV4 requires them encoded.
 * Getting this wrong produces signatures that verify locally and are rejected
 * by the server, so it is centralised here rather than inlined.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Encode an object key as a canonical URI path, preserving `/` separators. */
export function encodeKeyPath(key: string): string {
  return key
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/');
}

/** `20240115T093000Z` and `20240115` — the two date formats SigV4 uses. */
function formatDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function credentialScope(dateStamp: string, region: string, service: string): string {
  return `${dateStamp}/${region}/${service}/aws4_request`;
}

function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, 'aws4_request');
}

/**
 * Build the canonical query string: parameters sorted by encoded name, then by
 * encoded value, each `name=value` pair percent-encoded.
 */
function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * Canonical headers must be lowercase, sorted by name, with values trimmed and
 * internal whitespace collapsed.
 */
function canonicalHeaders(headers: Record<string, string>): {
  canonical: string;
  signed: string;
} {
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return {
    canonical: entries.map(([k, v]) => `${k}:${v}\n`).join(''),
    signed: entries.map(([k]) => k).join(';'),
  };
}

function buildCanonicalRequest(input: {
  method: string;
  canonicalUri: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
}): { canonicalRequest: string; signedHeaders: string } {
  const { canonical, signed } = canonicalHeaders(input.headers);
  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    canonicalQuery(input.query),
    canonical,
    signed,
    input.payloadHash,
  ].join('\n');
  return { canonicalRequest, signedHeaders: signed };
}

function buildStringToSign(
  amzDate: string,
  scope: string,
  canonicalRequest: string
): string {
  return [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
}

export type SignedRequest = {
  url: string;
  headers: Record<string, string>;
};

/**
 * Sign a request with an `Authorization` header.
 *
 * `canonicalUri` must already be percent-encoded (use `encodeKeyPath`), and
 * `headers` must include `host`.
 */
export function signRequest(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  credentials: SigV4Credentials;
  now?: Date;
}): Record<string, string> {
  const { credentials } = input;
  const { amzDate, dateStamp } = formatDates(input.now ?? new Date());
  const scope = credentialScope(dateStamp, credentials.region, credentials.service);

  const headers: Record<string, string> = {
    ...input.headers,
    host: input.url.host,
    'x-amz-date': amzDate,
  };
  // S3 requires the payload hash as a header; other services do not send it,
  // and including it would change the canonical request.
  if (credentials.service === 's3') {
    headers['x-amz-content-sha256'] = input.payloadHash;
  }
  if (credentials.sessionToken) {
    headers['x-amz-security-token'] = credentials.sessionToken;
  }

  const query: Record<string, string> = {};
  input.url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method: input.method,
    canonicalUri: input.url.pathname,
    query,
    headers,
    payloadHash: input.payloadHash,
  });

  const signature = hmac(
    signingKey(credentials.secretAccessKey, dateStamp, credentials.region, credentials.service),
    buildStringToSign(amzDate, scope, canonicalRequest)
  ).toString('hex');

  return {
    ...headers,
    Authorization:
      `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/**
 * Produce a presigned URL that anyone holding it may fetch until it expires.
 *
 * Used so past-paper PDFs are downloaded straight from the bucket instead of
 * being buffered through a serverless function — Vercel caps a function
 * response at ~4.5 MB, and plenty of these papers are larger than that.
 */
export function presignUrl(input: {
  method: string;
  url: URL;
  expiresInSeconds: number;
  credentials: SigV4Credentials;
  /** Extra response-header overrides, e.g. `response-content-disposition`. */
  extraQuery?: Record<string, string>;
  now?: Date;
}): string {
  const { credentials } = input;
  const { amzDate, dateStamp } = formatDates(input.now ?? new Date());
  const scope = credentialScope(dateStamp, credentials.region, credentials.service);

  const query: Record<string, string> = {};
  input.url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  Object.assign(query, input.extraQuery ?? {});

  query['X-Amz-Algorithm'] = ALGORITHM;
  query['X-Amz-Credential'] = `${credentials.accessKeyId}/${scope}`;
  query['X-Amz-Date'] = amzDate;
  query['X-Amz-Expires'] = String(input.expiresInSeconds);
  query['X-Amz-SignedHeaders'] = 'host';
  if (credentials.sessionToken) {
    query['X-Amz-Security-Token'] = credentials.sessionToken;
  }

  const { canonicalRequest } = buildCanonicalRequest({
    method: input.method,
    canonicalUri: input.url.pathname,
    query,
    headers: { host: input.url.host },
    payloadHash: UNSIGNED_PAYLOAD,
  });

  const signature = hmac(
    signingKey(credentials.secretAccessKey, dateStamp, credentials.region, credentials.service),
    buildStringToSign(amzDate, scope, canonicalRequest)
  ).toString('hex');

  return `${input.url.origin}${input.url.pathname}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}

export { sha256Hex };
