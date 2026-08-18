import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeKey, KEY_PREFIX } from './keys.ts';
import type {
  ObjectMetadata,
  ObjectStore,
  PutOptions,
  StoredObject,
} from './types.ts';

/**
 * Filesystem-backed object store, for development and self-hosted deployments.
 *
 * Keys map onto directories that already exist in the repository, so a checkout
 * with the corpus present keeps working with no migration:
 *
 *   papers/…            -> pdf_extraction/…
 *   uploads/…           -> public/uploads/…
 *   extracted_images/…  -> public/extracted_images/…
 *   step-images/…       -> public/step-images/…
 *
 * This driver cannot issue signed URLs; `signedGetUrl` returns null and callers
 * stream the bytes instead.
 */

/** Where each top-level key prefix lives on disk, relative to the repo root. */
const PREFIX_ROOTS: Array<{ prefix: string; dir: string }> = [
  { prefix: KEY_PREFIX.papers, dir: 'pdf_extraction' },
  { prefix: KEY_PREFIX.uploads, dir: 'public/uploads' },
  { prefix: KEY_PREFIX.extractedImages, dir: 'public/extracted_images' },
  { prefix: KEY_PREFIX.stepImages, dir: 'public/step-images' },
];

const CONTENT_TYPES = new Map<string, string>([
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.json', 'application/json'],
  ['.zip', 'application/zip'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);

export function contentTypeForKey(key: string): string {
  return CONTENT_TYPES.get(path.extname(key).toLowerCase()) ?? 'application/octet-stream';
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export class LocalObjectStore implements ObjectStore {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(root: string = process.cwd()) {
    this.root = path.resolve(root);
  }

  /**
   * Translate a key to an absolute path, re-checking containment afterwards.
   *
   * `assertSafeKey` already rejects traversal, but this second check is cheap
   * and means a future change to key parsing cannot turn into a file read
   * outside the intended directory.
   */
  private toFilePath(key: string): string {
    assertSafeKey(key);
    const entry = PREFIX_ROOTS.find(
      (candidate) => key === candidate.prefix || key.startsWith(`${candidate.prefix}/`)
    );
    if (!entry) {
      throw new Error(`No local directory is mapped for storage key: ${key}`);
    }
    const base = path.resolve(this.root, entry.dir);
    const relative = key.slice(entry.prefix.length).replace(/^\//, '');
    const resolved = path.resolve(base, relative);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
      throw new Error(`Storage key escapes its root: ${key}`);
    }
    return resolved;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const filePath = this.toFilePath(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
  }

  async get(key: string): Promise<StoredObject | null> {
    const filePath = this.toFilePath(key);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return null;
      return {
        bytes: await readFile(filePath),
        size: info.size,
        contentType: contentTypeForKey(key),
      };
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  async head(key: string): Promise<ObjectMetadata | null> {
    const filePath = this.toFilePath(key);
    try {
      const info = await stat(filePath);
      if (!info.isFile()) return null;
      return { size: info.size, contentType: contentTypeForKey(key) };
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  }

  /**
   * List keys under a prefix.
   *
   * The prefix need not end at a directory boundary — `extracted_images/9702_`
   * lists every file in that directory whose name starts with `9702_`, which is
   * what the question-image lookup needs.
   */
  async list(prefix: string, limit = 1000): Promise<string[]> {
    const slash = prefix.lastIndexOf('/');
    const dirKey = slash === -1 ? prefix : prefix.slice(0, slash);
    const namePrefix = slash === -1 ? '' : prefix.slice(slash + 1);

    let dirPath: string;
    try {
      dirPath = this.toFilePath(dirKey);
    } catch {
      return [];
    }

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.startsWith(namePrefix))
        .map((entry) => `${dirKey}/${entry.name}`)
        .sort()
        .slice(0, limit);
    } catch (error) {
      if (isEnoent(error)) return [];
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await unlink(this.toFilePath(key));
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }

  /** The filesystem has no notion of a signed URL; callers stream instead. */
  async signedGetUrl(): Promise<string | null> {
    return null;
  }
}

/** Exported for tests and for `put` callers that want to record a MIME type. */
export type { PutOptions };
