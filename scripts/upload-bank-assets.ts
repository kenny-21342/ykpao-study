/**
 * Push question-bank crops into object storage.
 *
 * The extraction pipeline writes PNGs to a local asset root and records only
 * their sha256 and a relative path. `merge_to_neon.py` copies those rows to
 * Postgres but no image bytes, so before this script existed production
 * referenced files that lived on one laptop.
 *
 * Keys are content-addressed (`bank_assets/<ab>/<sha256>.png`), so a re-run
 * skips what is already there, two questions sharing a diagram share one
 * object, and nothing has to be recorded in the database to find a file again.
 *
 * Usage:
 *   npx tsx scripts/upload-bank-assets.ts --db pdf_extraction/bank/extract.db \
 *                                         --assets pdf_extraction/bank/assets
 *   npx tsx scripts/upload-bank-assets.ts --dry-run
 *
 * Run it BEFORE merging rows, so a question never reaches production pointing
 * at an image that is not yet servable.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getStorage } from '../lib/storage/index.ts';
import { bankAssetKey } from '../lib/storage/keys.ts';

type Args = {
  db: string;
  assets: string;
  dryRun: boolean;
  limit: number | null;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: 'pdf_extraction/bank/extract.db',
    assets: 'pdf_extraction/bank/assets',
    dryRun: false,
    limit: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--db') args.db = argv[++i];
    else if (flag === '--assets') args.assets = argv[++i];
    else if (flag === '--limit') args.limit = Number(argv[++i]);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const database = new DatabaseSync(path.resolve(args.db), { readOnly: true });

  const rows = database
    .prepare(
      `SELECT sha256, kind, relative_path, byte_size
       FROM bank_assets
       WHERE sha256 IS NOT NULL
       ORDER BY id` + (args.limit ? ` LIMIT ${args.limit}` : '')
    )
    .all() as { sha256: string; kind: string; relative_path: string; byte_size: number }[];

  console.log(`${rows.length} assets in ${args.db}`);
  if (args.dryRun) console.log('(dry run — nothing will be written)');

  const store = getStorage();
  let uploaded = 0;
  let skipped = 0;
  let missing = 0;
  let failed = 0;
  let bytes = 0;

  for (const row of rows) {
    const key = bankAssetKey(row.sha256);
    if (!key) {
      // A digest that is not a digest means a corrupt row, not a missing file.
      console.warn(`  ! ${row.sha256?.slice(0, 12)}: not a sha256, skipping`);
      failed += 1;
      continue;
    }

    // Content-addressed, so an object already there is byte-identical.
    if (await store.head(key)) {
      skipped += 1;
      continue;
    }

    // relative_path is stored relative to the asset root and already carries
    // its own "assets/sha256/<ab>/" prefix, so it joins on unmodified.
    const file = path.resolve(args.assets, row.relative_path);
    try {
      await stat(file);
    } catch {
      console.warn(`  ! ${row.sha256.slice(0, 12)}: no file at ${file}`);
      missing += 1;
      continue;
    }

    if (args.dryRun) {
      uploaded += 1;
      continue;
    }

    try {
      const body = await readFile(file);
      await store.put(key, body, { contentType: 'image/png' });
      uploaded += 1;
      bytes += body.byteLength;
    } catch (error) {
      console.error(`  ! ${row.sha256.slice(0, 12)}: ${(error as Error).message}`);
      failed += 1;
    }

    if ((uploaded + skipped) % 500 === 0) {
      console.log(`  ${uploaded + skipped}/${rows.length}…`);
    }
  }

  database.close();
  console.log(
    `\nuploaded ${uploaded}, already present ${skipped}, ` +
      `missing locally ${missing}, failed ${failed}` +
      (bytes ? `, ${(bytes / 1e6).toFixed(1)} MB sent` : '')
  );

  // A missing file means a question would render a broken image, so this is a
  // non-zero exit even though the rest of the run succeeded.
  if (missing > 0 || failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
