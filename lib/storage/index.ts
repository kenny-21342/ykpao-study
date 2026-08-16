import { LocalObjectStore } from './local-store.ts';
import { S3ObjectStore, type S3Config } from './s3-store.ts';
import type { ObjectStore } from './types.ts';

export { KEY_PREFIX, assertSafeKey, isSafeKey, keyFromPublicPath, paperKey, publicPathFromKey, InvalidStorageKeyError } from './keys.ts';
export { contentTypeForKey } from './local-store.ts';
export { LocalObjectStore } from './local-store.ts';
export { S3ObjectStore } from './s3-store.ts';
export type { ObjectStore, StoredObject, ObjectMetadata, PutOptions, SignedUrlOptions } from './types.ts';

/**
 * Driver selection.
 *
 * `STORAGE_DRIVER=s3` switches to object storage; anything else (including
 * unset) uses the filesystem. The default is deliberately local so that a
 * developer with the corpus checked out needs no configuration.
 *
 * Production is different: on a read-only, ephemeral serverless filesystem the
 * local driver cannot work, and silently serving 404s for every past paper is
 * a much worse failure than refusing to start. `assertStorageConfigured()`
 * makes that explicit.
 */

const DEFAULT_SIGNED_URL_TTL_SECONDS = 900; // 15 minutes

let cached: ObjectStore | null = null;

function readS3Config(): S3Config {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) missing.push(name);
    return value ?? '';
  };

  const bucket = required('STORAGE_BUCKET');
  const accessKeyId = required('STORAGE_ACCESS_KEY_ID');
  const secretAccessKey = required('STORAGE_SECRET_ACCESS_KEY');

  if (missing.length > 0) {
    throw new Error(
      `STORAGE_DRIVER=s3 but these variables are unset: ${missing.join(', ')}`
    );
  }

  const ttl = Number.parseInt(process.env.STORAGE_SIGNED_URL_TTL ?? '', 10);
  const forcePathStyle = process.env.STORAGE_FORCE_PATH_STYLE;

  return {
    bucket,
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.STORAGE_SESSION_TOKEN || undefined,
    // R2 ignores the region but still requires one in the signature; `auto` is
    // the value Cloudflare documents.
    region: process.env.STORAGE_REGION || 'auto',
    endpoint: process.env.STORAGE_ENDPOINT || undefined,
    forcePathStyle:
      forcePathStyle === undefined ? undefined : forcePathStyle !== 'false',
    publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL || undefined,
    signedUrlTtlSeconds:
      Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_SIGNED_URL_TTL_SECONDS,
  };
}

/** Which driver the current environment selects. */
export function storageDriver(): 'local' | 's3' {
  return (process.env.STORAGE_DRIVER ?? 'local').toLowerCase() === 's3' ? 's3' : 'local';
}

/** The process-wide object store. */
export function getStorage(): ObjectStore {
  if (cached) return cached;
  cached = storageDriver() === 's3' ? new S3ObjectStore(readS3Config()) : new LocalObjectStore();
  return cached;
}

/** Reset the memoised store. Tests only. */
export function resetStorageForTests(): void {
  cached = null;
}

/**
 * Fail fast when a production deploy is still pointed at the filesystem.
 *
 * Called from `lib/env.ts` at startup. Set `STORAGE_ALLOW_LOCAL_IN_PRODUCTION`
 * for a self-hosted production box with real, persistent disks.
 */
export function assertStorageConfigured(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (storageDriver() === 's3') {
    readS3Config(); // throws with the list of missing variables
    return;
  }
  if (process.env.STORAGE_ALLOW_LOCAL_IN_PRODUCTION === 'true') return;

  throw new Error(
    'STORAGE_DRIVER is not set to "s3" in production. Past papers, uploads and ' +
      'question images are read from the filesystem, which on a serverless host ' +
      'is read-only, empty and discarded between invocations — every one of them ' +
      'would 404. Configure object storage, or set ' +
      'STORAGE_ALLOW_LOCAL_IN_PRODUCTION=true if this host has persistent disks.'
  );
}
