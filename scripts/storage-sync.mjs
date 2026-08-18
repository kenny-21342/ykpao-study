#!/usr/bin/env node
/**
 * Upload the local bulk-asset trees into the configured object store.
 *
 * This is the one-time (and thereafter incremental) migration behind
 * `STORAGE_DRIVER=s3`. Run it from a machine that has the corpus checked out:
 *
 *   STORAGE_DRIVER=s3 STORAGE_BUCKET=… STORAGE_ACCESS_KEY_ID=… \
 *   STORAGE_SECRET_ACCESS_KEY=… STORAGE_ENDPOINT=… \
 *   node scripts/storage-sync.mjs
 *
 * Options:
 *   --prefix <name>   Sync only one tree (papers, uploads, extracted_images,
 *                     step-images). Repeatable.
 *   --dry-run         List what would be uploaded; transfer nothing.
 *   --force           Re-upload objects that are already present.
 *   --concurrency <n> Parallel uploads (default 8).
 *   --all-extensions  Ignore per-tree extension filters (the papers tree is
 *                     limited to .pdf by default).
 *
 * Existing objects are skipped by default after a HEAD, so an interrupted run
 * resumes cheaply. ~13,000 PDFs at 6.5 GB take a while; this is expected.
 */

import { readdir, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const TREES = [
  // `pdf_extraction/` is the Python pipeline's working directory as well as the
  // paper corpus — it holds source, audio, caches and intermediate artefacts,
  // roughly 17 GB against 6.5 GB of actual PDFs. `readPaperPdf` only ever
  // serves PDFs, so uploading the rest would cost hours and gigabytes for
  // objects nothing can request. Pass `--all-extensions` to override.
  { name: 'papers', dir: 'pdf_extraction', prefix: 'papers', extensions: ['.pdf'] },
  { name: 'uploads', dir: 'public/uploads', prefix: 'uploads' },
  { name: 'extracted_images', dir: 'public/extracted_images', prefix: 'extracted_images' },
  { name: 'step-images', dir: 'public/step-images', prefix: 'step-images' },
];

/**
 * Directories inside the trees that hold pipeline working state rather than
 * assets the app serves. Uploading them would cost hours and gigabytes for
 * files nothing reads.
 */
const SKIP_DIRECTORIES = new Set([
  '__pycache__',
  '.pytest_cache',
  '.ipynb_checkpoints',
  'node_modules',
  '.git',
  '.venv',
]);

const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

function parseArgs(argv) {
  const options = {
    prefixes: [],
    dryRun: false,
    force: false,
    concurrency: 8,
    allExtensions: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--all-extensions') options.allExtensions = true;
    else if (arg === '--prefix') options.prefixes.push(argv[++i]);
    else if (arg === '--concurrency') options.concurrency = Number.parseInt(argv[++i], 10);
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    console.error('--concurrency must be a positive integer');
    process.exit(2);
  }
  return options;
}

/** Yield every file under `dir` as a `{ absolute, relative }` pair. */
async function* walk(dir, base = dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      yield* walk(absolute, base);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      yield { absolute, relative: path.relative(base, absolute).split(path.sep).join('/') };
    }
  }
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/** Run `worker` over `items` with at most `limit` in flight. */
async function pooled(items, limit, worker) {
  const queue = items[Symbol.iterator]();
  const runners = Array.from({ length: limit }, async () => {
    for (;;) {
      const next = queue.next();
      if (next.done) return;
      await worker(next.value);
    }
  });
  await Promise.all(runners);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const { getStorage, storageDriver, contentTypeForKey } = await import('../lib/storage/index.ts');

  if (storageDriver() !== 's3' && !options.dryRun) {
    console.error(
      'STORAGE_DRIVER is not "s3". This script would copy the local trees onto\n' +
        'themselves. Set STORAGE_DRIVER=s3 with the bucket credentials, or pass\n' +
        '--dry-run to preview.'
    );
    process.exit(1);
  }

  const store = getStorage();
  const selected = options.prefixes.length
    ? TREES.filter((tree) => options.prefixes.includes(tree.name))
    : TREES;

  if (selected.length === 0) {
    console.error(`No tree matched. Known trees: ${TREES.map((t) => t.name).join(', ')}`);
    process.exit(2);
  }

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  let uploadedBytes = 0;

  for (const tree of selected) {
    const root = path.resolve(process.cwd(), tree.dir);
    const exists = await stat(root).then((s) => s.isDirectory(), () => false);
    if (!exists) {
      console.log(`- ${tree.name}: ${tree.dir} does not exist, skipping`);
      continue;
    }

    const files = [];
    let excluded = 0;
    for await (const file of walk(root)) {
      if (
        tree.extensions &&
        !options.allExtensions &&
        !tree.extensions.includes(path.extname(file.relative).toLowerCase())
      ) {
        excluded++;
        continue;
      }
      files.push(file);
    }
    console.log(
      `- ${tree.name}: ${files.length} files under ${tree.dir}` +
        (excluded ? ` (${excluded} skipped by extension filter)` : '')
    );

    await pooled(files, options.concurrency, async (file) => {
      const key = `${tree.prefix}/${file.relative}`;
      try {
        if (!options.force && !options.dryRun && (await store.head(key))) {
          skipped++;
          return;
        }
        const info = await stat(file.absolute);
        if (options.dryRun) {
          uploaded++;
          uploadedBytes += info.size;
          return;
        }
        const bytes = await readFile(file.absolute);
        await store.put(key, bytes, {
          contentType: contentTypeForKey(key),
          cacheControl: 'public, max-age=31536000, immutable',
        });
        uploaded++;
        uploadedBytes += info.size;
        if (uploaded % 250 === 0) {
          console.log(`  … ${uploaded} uploaded (${formatBytes(uploadedBytes)})`);
        }
      } catch (error) {
        failed++;
        console.error(`  ! ${key}: ${error instanceof Error ? error.message : error}`);
      }
    });
  }

  const verb = options.dryRun ? 'would upload' : 'uploaded';
  console.log(
    `\n${verb} ${uploaded} objects (${formatBytes(uploadedBytes)}), ` +
      `skipped ${skipped} already present, ${failed} failed.`
  );
  // A partial sync is worse than an obvious failure: it looks like it worked
  // and then 404s at random for students.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
