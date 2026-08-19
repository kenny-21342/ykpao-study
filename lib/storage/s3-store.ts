import { XMLParser } from './xml.ts';
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
    const headers: Record<string, string> = {
      'content-type': options.contentType ?? contentTypeForKey(key),
      'content-length': String(body.byteLength),
    };
    if (options.cacheControl) headers['cache-control'] = options.cacheControl;

    const response = await this.send('PUT', this.urlFor(key), body, headers);
    if (!response.ok) await this.fail('put', key, response);
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

    return presignUrl({
      method: 'GET',
      url: this.urlFor(key),
      expiresInSeconds: options.expiresInSeconds ?? this.config.signedUrlTtlSeconds,
      credentials: this.credentials,
      extraQuery,
    });
  }
}
