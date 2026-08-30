/**
 * The object-storage abstraction the app reads and writes bulk files through.
 *
 * Two drivers implement it:
 *   - `local`  — the filesystem, for development and self-hosting.
 *   - `s3`     — any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2,
 *                MinIO), for serverless deploys where the filesystem is
 *                read-only and ephemeral.
 *
 * Keys are always POSIX-style, slash-separated, and rooted at one of the
 * prefixes in `lib/storage/keys.ts`. They never contain `..`, a leading slash,
 * a backslash, or a NUL — `assertSafeKey` enforces that at the boundary so no
 * driver has to re-derive it.
 */

export type StoredObject = {
  bytes: Buffer;
  size: number;
  contentType: string | null;
};

export type ObjectMetadata = {
  size: number;
  contentType: string | null;
};

export type PutOptions = {
  contentType?: string;
  /** Cache-Control to store alongside the object, for drivers that support it. */
  cacheControl?: string;
};

export type SignedUrlOptions = {
  expiresInSeconds?: number;
  /** When set, asks the store to return this as `Content-Disposition`. */
  contentDisposition?: string;
  contentType?: string;
  /**
   * When set, asks the store to return this as `Cache-Control` on the object.
   * Without it the bucket's own header wins, and R2 defaults to `no-cache`.
   */
  cacheControl?: string;
  /**
   * Round the signing timestamp down to a multiple of this many seconds.
   *
   * A signed URL is normally unique per call, because the signature covers the
   * current time to the second. That makes it uncacheable: every render mints a
   * new URL, so the browser has never seen it before and fetches the bytes
   * again. Quantising the timestamp makes the URL identical for every caller
   * inside the window, which is what lets `cacheControl` do anything at all.
   *
   * Only safe for immutable keys. `expiresInSeconds` must exceed the window,
   * or a URL minted at the end of one expires almost immediately.
   */
  stableWindowSeconds?: number;
};

export interface ObjectStore {
  /** Which driver this is — routes branch on it to decide redirect vs. stream. */
  readonly kind: 'local' | 's3';

  put(key: string, body: Buffer, options?: PutOptions): Promise<void>;

  /** Full object body, or null when the key does not exist. */
  get(key: string): Promise<StoredObject | null>;

  /** Size and content type without transferring the body; null when absent. */
  head(key: string): Promise<ObjectMetadata | null>;

  /** Keys under a prefix. Bounded by `limit`; order is lexicographic. */
  list(prefix: string, limit?: number): Promise<string[]>;

  delete(key: string): Promise<void>;

  /**
   * A time-limited URL a browser can fetch directly, or `null` when the driver
   * cannot issue one (the local driver). Callers must handle null by streaming
   * the bytes themselves.
   */
  signedGetUrl(key: string, options?: SignedUrlOptions): Promise<string | null>;
}
