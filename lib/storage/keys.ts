/**
 * Object-storage key construction and validation.
 *
 * Every key that reaches a driver passes through `assertSafeKey`, so path
 * traversal is rejected once, here, rather than being re-checked in each
 * driver. The local driver joins these onto a real directory, so a key that
 * escapes its prefix is an arbitrary-file-read.
 */

/** Top-level prefixes. These double as the on-disk layout for the local driver. */
export const KEY_PREFIX = {
  /** Past-paper PDFs, keyed by their path relative to `pdf_extraction/`. */
  papers: 'papers',
  /** User and admin uploads: `uploads/images/<uuid>.ext`, `uploads/files/...`. */
  uploads: 'uploads',
  /** Diagram images extracted from past papers. */
  extractedImages: 'extracted_images',
  /** Images scraped for STEP questions. */
  stepImages: 'step-images',
} as const;

export class InvalidStorageKeyError extends Error {
  constructor(key: string, reason: string) {
    // The key is caller-supplied and may be attacker-controlled; it is safe to
    // include because this error is logged, never returned to the client.
    super(`Invalid storage key (${reason}): ${JSON.stringify(key)}`);
    this.name = 'InvalidStorageKeyError';
  }
}

/**
 * Validate a key, returning it normalised.
 *
 * Rejects absolute paths, `..` segments, backslashes, NUL bytes, empty
 * segments, and anything over 1024 characters (the S3 key limit).
 */
export function assertSafeKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new InvalidStorageKeyError(String(key), 'empty');
  }
  if (key.length > 1024) throw new InvalidStorageKeyError(key, 'too long');
  if (key.includes('\0')) throw new InvalidStorageKeyError(key, 'NUL byte');
  if (key.includes('\\')) throw new InvalidStorageKeyError(key, 'backslash');
  if (key.startsWith('/')) throw new InvalidStorageKeyError(key, 'absolute');

  const segments = key.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new InvalidStorageKeyError(key, 'traversal or empty segment');
    }
  }
  return key;
}

/** True when `key` is safe; for callers that prefer a boolean to a throw. */
export function isSafeKey(key: string): boolean {
  try {
    assertSafeKey(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Map a stored past-paper path to its object key.
 *
 * Stored paths are relative to `pdf_extraction/` (e.g.
 * `my_raw_pdfs/igcse/physics-0625/0625_w21_qp_63.pdf`); older rows kept the
 * `pdf_extraction/` prefix, so it is tolerated and stripped.
 *
 * Returns null rather than throwing: these values come from the database and a
 * malformed row should render as "unavailable", not a 500.
 */
export function paperKey(storedPath: string): string | null {
  if (typeof storedPath !== 'string') return null;
  const normalized = storedPath.replace(/\\/g, '/');

  // An absolute stored path is a malformed row. Stripping the leading slash
  // would keep it inside the papers prefix — harmless, but it silently turns
  // `/etc/passwd` into a lookup for `papers/etc/passwd`, which is a confusing
  // 404 rather than an obvious bad-data signal.
  if (normalized.startsWith('/')) return null;

  const withoutDotSlash = normalized.replace(/^\.\//, '');
  const relative = withoutDotSlash.startsWith('pdf_extraction/')
    ? withoutDotSlash.slice('pdf_extraction/'.length)
    : withoutDotSlash;
  if (!relative) return null;
  const key = `${KEY_PREFIX.papers}/${relative}`;
  return isSafeKey(key) ? key : null;
}

/**
 * Map a public URL path such as `/uploads/images/x.png` to its object key.
 * Returns null when the path is not one of the storage-backed prefixes.
 */
export function keyFromPublicPath(publicPath: string): string | null {
  const trimmed = publicPath.split('?')[0].split('#')[0].replace(/^\/+/, '');
  const prefix = trimmed.split('/')[0];
  const allowed: string[] = [
    KEY_PREFIX.uploads,
    KEY_PREFIX.extractedImages,
    KEY_PREFIX.stepImages,
  ];
  if (!allowed.includes(prefix)) return null;

  // Percent-decoding can reintroduce `..`; decode first, then validate.
  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    return null;
  }
  return isSafeKey(decoded) ? decoded : null;
}

/** The public URL path an object key is served at (the inverse of the above). */
export function publicPathFromKey(key: string): string {
  return `/${key}`;
}
