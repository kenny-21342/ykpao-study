import assert from 'node:assert/strict';
import { test } from 'node:test';
import { S3ObjectStore } from '../lib/storage/s3-store.ts';
import { buildCompleteMultipartUploadXml, XMLParser } from '../lib/storage/xml.ts';

/**
 * The multipart path cannot be exercised against the real bucket in CI, and it
 * is the code that runs only on the handful of largest objects in the corpus —
 * exactly the ones nobody notices are missing until a student opens one. So the
 * whole handshake is driven against a stub `fetch` that records the sequence.
 */

const MIB = 1024 * 1024;

const CONFIG = {
  bucket: 'papers',
  region: 'auto',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  endpoint: 'https://account.r2.cloudflarestorage.com',
  signedUrlTtlSeconds: 900,
};

type Call = { method: string; url: URL; body?: Uint8Array };

/**
 * Install a `fetch` that records every call and answers from `respond`.
 * Returns the recorded calls and a restore function.
 */
function stubFetch(respond: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: URL | string, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url: new URL(String(input)),
      body: init.body as Uint8Array | undefined,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function xml(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init });
}

/**
 * Force multipart, with the smallest part size S3 allows, so a few megabytes
 * produce several parts and the test does not have to move 32 MiB.
 */
async function withSmallThreshold<T>(run: () => Promise<T>): Promise<T> {
  process.env.STORAGE_MULTIPART_THRESHOLD_MB = '1';
  process.env.STORAGE_MULTIPART_PART_MB = '5';
  try {
    // Must await inside the try: the part size is read after the create call
    // resolves, so restoring the environment synchronously would restore it
    // before the parts are sized.
    return await run();
  } finally {
    delete process.env.STORAGE_MULTIPART_THRESHOLD_MB;
    delete process.env.STORAGE_MULTIPART_PART_MB;
  }
}

test('buildCompleteMultipartUploadXml orders parts and escapes ETags', () => {
  const body = buildCompleteMultipartUploadXml([
    { partNumber: 2, eTag: '"b&b"' },
    { partNumber: 1, eTag: '"aaa"' },
  ]);
  assert.equal(
    body,
    '<CompleteMultipartUpload>' +
      '<Part><PartNumber>1</PartNumber><ETag>&quot;aaa&quot;</ETag></Part>' +
      '<Part><PartNumber>2</PartNumber><ETag>&quot;b&amp;b&quot;</ETag></Part>' +
      '</CompleteMultipartUpload>'
  );
});

test('parseError only fires on a real Error envelope', () => {
  assert.equal(XMLParser.parseError('<CompleteMultipartUploadResult/>'), undefined);
  // The word "Error" inside a value must not be mistaken for the envelope.
  assert.equal(XMLParser.parseError('<Message>Errors happen</Message>'), undefined);
  assert.deepEqual(XMLParser.parseError('<Error><Code>SlowDown</Code><Message>x</Message></Error>'), {
    code: 'SlowDown',
    message: 'x',
  });
});

test('put above the threshold runs the full multipart handshake', async () => {
  // 12 MiB against the 5 MiB part floor: 5 + 5 + 2.
  const body = Buffer.alloc(12 * MIB, 7);

  const { calls, restore } = stubFetch((call) => {
    if (call.method === 'POST' && call.url.searchParams.has('uploads')) {
      return xml('<InitiateMultipartUploadResult><UploadId>UP-1</UploadId></InitiateMultipartUploadResult>');
    }
    if (call.method === 'PUT') {
      const n = call.url.searchParams.get('partNumber');
      return new Response(null, { status: 200, headers: { etag: `"etag-${n}"` } });
    }
    return xml('<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>');
  });

  try {
    await withSmallThreshold(() =>
      new S3ObjectStore(CONFIG).put('papers/big.pdf', body, { contentType: 'application/pdf' })
    );
  } finally {
    restore();
  }

  const [create, ...rest] = calls;
  assert.equal(create.method, 'POST');
  assert.equal(create.url.pathname, '/papers/papers/big.pdf');

  const parts = rest.filter((c) => c.method === 'PUT');
  assert.deepEqual(
    parts.map((c) => c.url.searchParams.get('partNumber')).sort(),
    ['1', '2', '3']
  );
  assert.ok(parts.every((c) => c.url.searchParams.get('uploadId') === 'UP-1'));
  // Every part but the last is exactly one part size; together they are the file.
  assert.equal(parts.reduce((sum, c) => sum + (c.body?.byteLength ?? 0), 0), body.byteLength);

  const complete = calls.at(-1)!;
  assert.equal(complete.method, 'POST');
  assert.equal(complete.url.searchParams.get('uploadId'), 'UP-1');
  assert.equal(
    Buffer.from(complete.body!).toString('utf8'),
    buildCompleteMultipartUploadXml([
      { partNumber: 1, eTag: '"etag-1"' },
      { partNumber: 2, eTag: '"etag-2"' },
      { partNumber: 3, eTag: '"etag-3"' },
    ])
  );
});

test('a failed part is retried rather than failing the whole upload', async () => {
  // 11 MiB at a 5 MiB part size: 5 + 5 + 1.
  const body = Buffer.alloc(11 * MIB, 3);
  let firstPartTwo = true;

  const { calls, restore } = stubFetch((call) => {
    if (call.method === 'POST' && call.url.searchParams.has('uploads')) {
      return xml('<InitiateMultipartUploadResult><UploadId>UP-2</UploadId></InitiateMultipartUploadResult>');
    }
    if (call.method === 'PUT') {
      const n = call.url.searchParams.get('partNumber');
      if (n === '2' && firstPartTwo) {
        firstPartTwo = false;
        return xml('<Error><Code>InternalError</Code></Error>', { status: 500 });
      }
      return new Response(null, { status: 200, headers: { etag: `"etag-${n}"` } });
    }
    return xml('<CompleteMultipartUploadResult/>');
  });

  try {
    await withSmallThreshold(() => new S3ObjectStore(CONFIG).put('papers/big.pdf', body));
  } finally {
    restore();
  }

  assert.equal(calls.filter((c) => c.method === 'PUT').length, 3 + 1);
  assert.equal(firstPartTwo, false);
  assert.equal(calls.at(-1)!.method, 'POST');
});

test('a 200 carrying an Error body fails the put and aborts the upload', async () => {
  const body = Buffer.alloc(11 * MIB, 1);

  const { calls, restore } = stubFetch((call) => {
    if (call.method === 'POST' && call.url.searchParams.has('uploads')) {
      return xml('<InitiateMultipartUploadResult><UploadId>UP-3</UploadId></InitiateMultipartUploadResult>');
    }
    if (call.method === 'PUT') {
      return new Response(null, { status: 200, headers: { etag: '"e"' } });
    }
    if (call.method === 'DELETE') return new Response(null, { status: 204 });
    return xml('<Error><Code>InternalError</Code><Message>assembly failed</Message></Error>');
  });

  try {
    await assert.rejects(
      withSmallThreshold(() => new S3ObjectStore(CONFIG).put('papers/big.pdf', body)),
      /completeMultipartUpload failed: InternalError/
    );
  } finally {
    restore();
  }

  const abort = calls.at(-1)!;
  assert.equal(abort.method, 'DELETE');
  assert.equal(abort.url.searchParams.get('uploadId'), 'UP-3');
});

test('put below the threshold still uses a single PUT', async () => {
  const { calls, restore } = stubFetch(() => new Response(null, { status: 200 }));
  try {
    await new S3ObjectStore(CONFIG).put('papers/small.pdf', Buffer.alloc(1024));
  } finally {
    restore();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url.search, '');
});
