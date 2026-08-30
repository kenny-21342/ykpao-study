import { buildCompleteMultipartUploadXml, XMLParser } from './xml.ts';
import { assertSafeKey } from './keys.ts';
import { contentTypeForKey } from './local-store.ts';
import {
  EMPTY_BODY_SHA256,
  encodeKeyPath,
  presignUrl,
  sha256Hex,
  signRequest,
  type SigV4Credentials,
} from './sigv4.ts';
import type {
  ObjectMetadata,
  ObjectStore,
  PutOptions,
  SignedUrlOptions,
  StoredObject,
} from './types.ts';

/**
 * S3-compatible object store — AWS S3, Cloudflare R2, Backblaze B2, MinIO.
 *
 * Requests are signed with SigV4 (`./sigv4.ts`) and sent with `fetch`, so no
 * vendor SDK ships in the serverless bundle.
 */

export type S3Config = {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Custom endpoint, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint?: string;
  /**
   * Put the bucket in the path (`https://host/bucket/key`) rather than the
   * hostname. R2 and MinIO require this; AWS S3 prefers virtual-hosted style.
   * Defaults to true when a custom endpoint is set.
   */
  forcePathStyle?: boolean;
  /** Public base URL for objects served without a signature (a CDN origin). */
  publicBaseUrl?: string;
  /** Lifetime of generated signed URLs. */
  signedUrlTtlSeconds: number;
};

/**
 * Per-request ceiling. 30s suits a serverless handler, which must answer well
 * inside the platform's own function timeout. Bulk migration is the opposite
 * case: `scripts/storage-sync.mjs` pushes multi-megabyte PDFs from a home
 * connection, where a single PUT legitimately outlasts 30s, so that script
 * raises this via STORAGE_REQUEST_TIMEOUT_MS rather than failing files that
 * would have finished. Only the sync path should set it.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

function requestTimeoutMs(): number {
  const raw = Number(process.env.STORAGE_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

const MIB = 1024 * 1024;

/**
 * Above this size a single PUT is replaced by a multipart upload.
 *
 * The corpus is mostly 0.1-7 MB PDFs that a plain PUT handles fine, but a
 * handful of scanned bundles run to hundreds of megabytes, and one 205 MB
 * upload failed every pass of the R2 migration: a single PUT is one
 * all-or-nothing request, so a stall anywhere in it discards everything
 * transferred so far and the retry starts from zero. Multipart makes the unit
 * of failure one part instead of the whole file.
 */
const DEFAULT_MULTIPART_THRESHOLD = 32 * MIB;
/** S3 requires >= 5 MiB for every part but the last. */
const MIN_PART_SIZE = 5 * MIB;
const DEFAULT_PART_SIZE = 8 * MIB;
/** S3's hard ceiling on parts in one upload. */
const MAX_PARTS = 10_000;
const DEFAULT_PART_CONCURRENCY = 3;
/** Attempts per part, including the first. */
const PART_ATTEMPTS = 3;

function envInt(name: string, fallback: number, scale = 1): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw * scale) : fallback;
}

function multipartThreshold(): number {
  return envInt('STORAGE_MULTIPART_THRESHOLD_MB', DEFAULT_MULTIPART_THRESHOLD, MIB);
}

/**
 * Part size for a body of `size`, never below S3's 5 MiB floor and always
 * large enough to stay inside the 10,000-part ceiling — a 1 TB object needs
 * ~105 MiB parts, so the configured size is a floor rather than a promise.
 */
function partSizeFor(size: number): number {
  const configured = Math.max(
    MIN_PART_SIZE,
    envInt('STORAGE_MULTIPART_PART_MB', DEFAULT_PART_SIZE, MIB)
  );
  return Math.max(configured, Math.ceil(size / MAX_PARTS));
}

function partConcurrency(): number {
  return envInt('STORAGE_MULTIPART_CONCURRENCY', DEFAULT_PART_CONCURRENCY);
}

export class S3ObjectStore implements ObjectStore {
  readonly kind = 's3' as const;
  private readonly config: S3Config;
  private readonly credentials: SigV4Credentials;

  constructor(config: S3Config) {
    this.config = config;
    this.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken,
      region: config.region,
      service: 's3',
    };
  }

  private get pathStyle(): boolean {
    return this.config.forcePathStyle ?? Boolean(this.config.endpoint);
  }

  /** Build the request URL for a key (or for the bucket root when omitted). */
  private urlFor(key?: string): URL {
    const encodedKey = key ? encodeKeyPath(key) : '';
    if (this.config.endpoint) {
      const base = new URL(this.config.endpoint);
      const prefix = this.pathStyle ? `/${this.config.bucket}` : '';
      const host = this.pathStyle
        ? base.host
        : `${this.config.bucket}.${base.host}`;
      return new URL(`${base.protocol}//${host}${prefix}/${encodedKey}`);
    }
    // No endpoint: AWS S3, virtual-hosted style.
    return new URL(
      `https://${this.config.bucket}.s3.${this.config.region}.amazonaws.com/${encodedKey}`
    );
  }

  private async send(
    method: string,
    url: URL,
    body?: Buffer,
    extraHeaders: Record<string, string> = {}
  ): Promise<Response> {
    const payloadHash = body ? sha256Hex(body) : EMPTY_BODY_SHA256;
    const headers = signRequest({
      method,
      url,
      headers: extraHeaders,
      payloadHash,
      credentials: this.credentials,
    });

    return fetch(url, {
      method,
      headers,
      body: body ? new Uint8Array(body) : undefined,
      signal: AbortSignal.timeout(requestTimeoutMs()),
      // Bodies are already fully in memory; no need for duplex streaming.
      cache: 'no-store',
    });
  }

  /**
   * Turn a non-2xx response into an Error, without letting the bucket's own
   * error body reach the client. The body is read for the log line only.
   */
  private async fail(operation: string, key: string, response: Response): Promise<never> {
    const body = await response.text().catch(() => '');
    console.error(
      '[storage/s3] %s failed for %s: %d %s %s',
      operation,
      key,
      response.status,
      response.statusText,
      body.slice(0, 500)
    );
    throw new Error(`Object storage ${operation} failed with status ${response.status}`);
  }

  async put(key: string, body: Buffer, options: PutOptions = {}): Promise<void> {
    assertSafeKey(key);
    if (body.byteLength > multipartThreshold()) {
      return this.putMultipart(key, body, options);
    }

    const headers: Record<string, string> = {
      'content-type': options.contentType ?? contentTypeForKey(key),
      'content-length': String(body.byteLength),
    };
    if (options.cacheControl) headers['cache-control'] = options.cacheControl;

    const response = await this.send('PUT', this.urlFor(key), body, headers);
    if (!response.ok) await this.fail('put', key, response);
  }

  /**
   * Upload a large body as a multipart upload: create, send the parts, then
   * complete. On any failure the upload is aborted, so a retry does not leave
   * the bucket accruing storage for parts that will never be assembled.
   */
  private async putMultipart(key: string, body: Buffer, options: PutOptions): Promise<void> {
    const uploadId = await this.createMultipartUpload(key, options);
    try {
      const parts = await this.uploadParts(key, body, uploadId);
      await this.completeMultipartUpload(key, uploadId, parts);
    } catch (error) {
      await this.abortMultipartUpload(key, uploadId);
      throw error;
    }
  }

  private async createMultipartUpload(key: string, options: PutOptions): Promise<string> {
    const url = this.urlFor(key);
    // `?uploads` is a valueless flag; URLSearchParams renders it as `uploads=`,
    // which is exactly what SigV4 canonicalises to, so signature and wire form
    // agree.
    url.searchParams.set('uploads', '');

    const headers: Record<string, string> = {
      'content-type': options.contentType ?? contentTypeForKey(key),
    };
    if (options.cacheControl) headers['cache-control'] = options.cacheControl;

    const response = await this.send('POST', url, undefined, headers);
    if (!response.ok) await this.fail('createMultipartUpload', key, response);

    const uploadId = XMLParser.parseUploadId(await response.text());
    if (!uploadId) {
      throw new Error('Object storage createMultipartUpload returned no UploadId');
    }
    return uploadId;
  }

  private async uploadParts(
    key: string,
    body: Buffer,
    uploadId: string
  ): Promise<Array<{ partNumber: number; eTag: string }>> {
    const partSize = partSizeFor(body.byteLength);
    const total = Math.ceil(body.byteLength / partSize);
    const parts: Array<{ partNumber: number; eTag: string }> = [];

    let next = 0;
    const workers = Array.from({ length: Math.min(partConcurrency(), total) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= total) return;
        const offset = index * partSize;
        // `subarray` shares memory with `body`; no copy per part.
        const chunk = body.subarray(offset, Math.min(offset + partSize, body.byteLength));
        parts.push({
          partNumber: index + 1,
          eTag: await this.uploadPart(key, uploadId, index + 1, chunk),
        });
      }
    });
    await Promise.all(workers);

    return parts;
  }

  /**
   * One part, retried on failure. Retrying is safe and cheap here: a part is
   * addressed by number, so re-sending it replaces the previous attempt rather
   * than appending, and only that part's bytes go over the wire again.
   */
  private async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    chunk: Buffer,
    attempt = 1
  ): Promise<string> {
    const url = this.urlFor(key);
    url.searchParams.set('partNumber', String(partNumber));
    url.searchParams.set('uploadId', uploadId);

    try {
      const response = await this.send('PUT', url, chunk, {
        'content-length': String(chunk.byteLength),
      });
      if (!response.ok) await this.fail(`uploadPart ${partNumber}`, key, response);

      const eTag = response.headers.get('etag');
      if (!eTag) throw new Error(`Object storage uploadPart ${partNumber} returned no ETag`);
      return eTag;
    } catch (error) {
      if (attempt >= PART_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
      return this.uploadPart(key, uploadId, partNumber, chunk, attempt + 1);
    }
  }

  private async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: ReadonlyArray<{ partNumber: number; eTag: string }>
  ): Promise<void> {
    const url = this.urlFor(key);
    url.searchParams.set('uploadId', uploadId);

    const xml = Buffer.from(buildCompleteMultipartUploadXml(parts), 'utf8');
    const response = await this.send('POST', url, xml, {
      'content-type': 'application/xml',
      'content-length': String(xml.byteLength),
    });
    if (!response.ok) await this.fail('completeMultipartUpload', key, response);

    // A 200 here is not yet success — see `XMLParser.parseError`.
    const failure = XMLParser.parseError(await response.text());
    if (failure) {
      console.error(
        '[storage/s3] completeMultipartUpload failed for %s: %s %s',
        key,
        failure.code ?? 'unknown',
        failure.message ?? ''
      );
      throw new Error(
        `Object storage completeMultipartUpload failed: ${failure.code ?? 'unknown error'}`
      );
    }
  }

  /**
   * Best-effort abort. The caller is already throwing the real error, so a
   * failure to clean up is logged and swallowed rather than replacing it.
   */
  private async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const url = this.urlFor(key);
    url.searchParams.set('uploadId', uploadId);
    try {
      const response = await this.send('DELETE', url);
      if (!response.ok && response.status !== 404) {
        console.error(
          '[storage/s3] abortMultipartUpload for %s returned %d',
          key,
          response.status
        );
      }
    } catch (error) {
      console.error(
        '[storage/s3] abortMultipartUpload for %s threw: %s',
        key,
        error instanceof Error ? error.message : error
      );
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    assertSafeKey(key);
    const response = await this.send('GET', this.urlFor(key));
    if (response.status === 404) return null;
    if (!response.ok) await this.fail('get', key, response);

    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      bytes,
      size: bytes.byteLength,
      contentType: response.headers.get('content-type'),
    };
  }

  async head(key: string): Promise<ObjectMetadata | null> {
    assertSafeKey(key);
    const response = await this.send('HEAD', this.urlFor(key));
    if (response.status === 404) return null;
    if (!response.ok) await this.fail('head', key, response);

    const length = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    return {
      size: Number.isFinite(length) ? length : 0,
      contentType: response.headers.get('content-type'),
    };
  }

  /**
   * List keys under a prefix using ListObjectsV2, following continuation
   * tokens until `limit` keys are collected.
   */
  async list(prefix: string, limit = 1000): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const url = this.urlFor();
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', prefix);
      url.searchParams.set('max-keys', String(Math.min(1000, limit - keys.length)));
      if (continuationToken) url.searchParams.set('continuation-token', continuationToken);

      const response = await this.send('GET', url);
      if (!response.ok) await this.fail('list', prefix, response);

      const xml = await response.text();
      const parsed = XMLParser.parseListObjects(xml);
      keys.push(...parsed.keys);
      continuationToken = parsed.isTruncated ? parsed.nextContinuationToken : undefined;
    } while (continuationToken && keys.length < limit);

    return keys.slice(0, limit).sort();
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    const response = await this.send('DELETE', this.urlFor(key));
    // S3 returns 204 for a successful delete and for a key that never existed.
    if (!response.ok && response.status !== 404) await this.fail('delete', key, response);
  }

  async signedGetUrl(key: string, options: SignedUrlOptions = {}): Promise<string | null> {
    assertSafeKey(key);

    // With a public CDN base URL in front of the bucket, no signature is
    // needed — and the CDN can cache, which a signed URL defeats.
    if (this.config.publicBaseUrl) {
      return `${this.config.publicBaseUrl.replace(/\/+$/, '')}/${encodeKeyPath(key)}`;
    }

    const extraQuery: Record<string, string> = {};
    if (options.contentDisposition) {
      extraQuery['response-content-disposition'] = options.contentDisposition;
    }
    if (options.contentType) {
      extraQuery['response-content-type'] = options.contentType;
    }
    if (options.cacheControl) {
      extraQuery['response-cache-control'] = options.cacheControl;
    }

    // Quantise the signing time so repeated calls for the same key inside a
    // window produce byte-identical URLs, which is the only way a browser can
    // reuse what it already downloaded. See SignedUrlOptions.
    const window = options.stableWindowSeconds;
    const now =
      window && window > 0
        ? new Date(Math.floor(Date.now() / (window * 1000)) * window * 1000)
        : undefined;

    return presignUrl({
      method: 'GET',
      url: this.urlFor(key),
      expiresInSeconds: options.expiresInSeconds ?? this.config.signedUrlTtlSeconds,
      credentials: this.credentials,
      extraQuery,
      now,
    });
  }
}
