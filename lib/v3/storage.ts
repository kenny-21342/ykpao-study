import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { sha256, stableId } from "./ids.ts";

const MIME_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

export type StoredAsset = {
  id: string;
  sha256: string;
  relativePath: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
};

export type PutAssetInput = {
  bytes: Buffer;
  mimeType: "image/png" | "image/webp";
  width: number;
  height: number;
};

export interface AssetStore {
  put(input: PutAssetInput): Promise<StoredAsset>;
  read(relativePath: string): Promise<Buffer>;
  exists(relativePath: string): Promise<boolean>;
  resolve(relativePath: string): string;
}

export interface RecordPublisher<TRecord = unknown, TResult = unknown> {
  publish(record: TRecord): Promise<TResult>;
}

/**
 * V3 assets held in the shared object store (`lib/storage/`).
 *
 * Content-addressed by sha256, so a key is written at most once and `put` can
 * skip the upload when the object is already there.
 */
export class ObjectAssetStore implements AssetStore {
  async put(input: PutAssetInput): Promise<StoredAsset> {
    const { hash, extension } = describeAsset(input);
    const relativePath = `${hash}.${extension}`;
    const { getStorage } = await import("../storage/index.ts");
    const store = getStorage();
    const key = v3AssetKey(relativePath);

    if (!(await store.head(key))) {
      await store.put(key, input.bytes, {
        contentType: input.mimeType,
        cacheControl: "public, max-age=31536000, immutable",
      });
    }

    return {
      id: stableId("v3a", { sha256: hash }),
      sha256: hash,
      relativePath,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      width: input.width,
      height: input.height,
    };
  }

  async read(relativePath: string): Promise<Buffer> {
    const { getStorage } = await import("../storage/index.ts");
    const object = await getStorage().get(v3AssetKey(relativePath));
    if (!object) throw new Error("V3 asset not found");
    return object.bytes;
  }

  async exists(relativePath: string): Promise<boolean> {
    const { getStorage } = await import("../storage/index.ts");
    return (await getStorage().head(v3AssetKey(relativePath))) !== null;
  }

  resolve(relativePath: string): string {
    return v3AssetKey(relativePath);
  }
}

/** Validate a V3 asset filename and turn it into a storage key. */
function v3AssetKey(relativePath: string): string {
  if (!V3_ASSET_NAME_RE.test(relativePath)) {
    throw new Error("Invalid V3 asset path");
  }
  return `v3/assets/${relativePath}`;
}

const V3_ASSET_NAME_RE = /^[a-f0-9]{64}\.(png|webp)$/;

function describeAsset(input: PutAssetInput): { hash: string; extension: string } {
  if (!Number.isInteger(input.width) || input.width <= 0) throw new Error("Asset width must be positive");
  if (!Number.isInteger(input.height) || input.height <= 0) throw new Error("Asset height must be positive");
  const extension = MIME_EXTENSIONS.get(input.mimeType);
  if (!extension) throw new Error(`Unsupported asset MIME type: ${input.mimeType}`);
  return { hash: sha256(input.bytes), extension };
}

/**
 * Pick the asset store matching the configured storage driver.
 *
 * V3 is an internal admin tool, but it still runs inside the same serverless
 * deploy, where `LocalAssetStore` would write into a read-only filesystem.
 */
export async function getV3AssetStore(assetRoot: string): Promise<AssetStore> {
  const { storageDriver } = await import("../storage/index.ts");
  return storageDriver() === "s3" ? new ObjectAssetStore() : new LocalAssetStore(assetRoot);
}

export class LocalAssetStore implements AssetStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async put(input: PutAssetInput): Promise<StoredAsset> {
    const { hash, extension } = describeAsset(input);
    const relativePath = `${hash}.${extension}`;
    const destination = this.resolve(relativePath);
    await mkdir(this.root, { recursive: true });

    try {
      await stat(destination);
    } catch {
      const temporary = `${destination}.partial-${process.pid}`;
      const handle = await open(temporary, "wx");
      try {
        await handle.writeFile(input.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, destination);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        const exists = await stat(destination).then(() => true, () => false);
        if (!exists) throw error;
      }
    }

    return {
      id: stableId("v3a", { sha256: hash }),
      sha256: hash,
      relativePath,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      width: input.width,
      height: input.height,
    };
  }

  read(relativePath: string): Promise<Buffer> {
    return readFile(this.resolve(relativePath));
  }

  async exists(relativePath: string): Promise<boolean> {
    return stat(this.resolve(relativePath)).then(() => true, () => false);
  }

  resolve(relativePath: string): string {
    if (!V3_ASSET_NAME_RE.test(relativePath)) {
      throw new Error("Invalid V3 asset path");
    }
    const resolved = path.resolve(this.root, relativePath);
    if (!resolved.startsWith(`${this.root}${path.sep}`)) throw new Error("Asset path escapes the V3 root");
    return resolved;
  }
}
