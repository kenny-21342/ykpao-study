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
  all: boolean;
  concurrency: number;
  skipHead: boolean;
};

type AssetRow = { sha256: string; relative_path: string };

/**
 * Assets reachable from something a student can actually open.
 *
 * Uploading every row means 400,328 objects and 15.7 GB; the questions and
 * mark schemes marked published between them reference 217,331 and 8.4 GB. The
 * rest belong to rows held back for review, and there is no reason to pay to
 * store or transfer them until they are released. --all overrides this.
 */
const PUBLISHED_ONLY = `
  SELECT DISTINCT a.sha256, a.relative_path
  FROM bank_assets a
  JOIN (
    SELECT s.asset_id FROM bank_question_strips s
      JOIN bank_questions q ON q.id = s.question_id WHERE q.status = 'published'
    UNION SELECT s.asset_id FROM bank_question_assets s
      JOIN bank_questions q ON q.id = s.question_id WHERE q.status = 'published'
    UNION SELECT s.asset_id FROM bank_mark_scheme_strips s
      JOIN bank_mark_schemes m ON m.id = s.mark_scheme_id WHERE m.status = 'published'
    UNION SELECT s.asset_id FROM bank_mark_scheme_assets s
      JOIN bank_mark_schemes m ON m.id = s.mark_scheme_id WHERE m.status = 'published'
  ) used ON used.asset_id = a.id
  WHERE a.sha256 IS NOT NULL
  ORDER BY a.sha256
`;

const EVERY_ASSET = `
  SELECT sha256, relative_path FROM bank_assets
  WHERE sha256 IS NOT NULL
  ORDER BY sha256
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: 'pdf_extraction/bank/extract.db',
    assets: 'pdf_extraction/bank/assets',
    dryRun: false,
    limit: null,
    all: false,
    concurrency: 12,
    skipHead: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--skip-head') args.skipHead = true;
    else if (flag === '--all') args.all = true;
    else if (flag === '--db') args.db = argv[++i];
    else if (flag === '--assets') args.assets = argv[++i];
    else if (flag === '--limit') args.limit = Number(argv[++i]);
    else if (flag === '--concurrency') args.concurrency = Number(argv[++i]);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const database = new DatabaseSync(path.resolve(args.db), { readOnly: true });

  const rows = database
    .prepare(
      (args.all ? EVERY_ASSET : PUBLISHED_ONLY) +
        (args.limit ? ` LIMIT ${args.limit}` : '')
    )
    .all() as AssetRow[];

  console.log(
    `${rows.length.toLocaleString()} assets to consider ` +
      `(${args.all ? 'every asset' : 'published rows only'})`
  );
  if (args.dryRun) console.log('(dry run — nothing will be written)');

  const store = getStorage();
  const counts = { uploaded: 0, skipped: 0, missing: 0, failed: 0, bytes: 0 };
  const started = Date.now();
  let next = 0;
  let reportedAt = 0;

  const report = () => {
    const done = counts.uploaded + counts.skipped + counts.missing + counts.failed;
    if (done - reportedAt < 2000) return;
    reportedAt = done;
    const rate = done / Math.max((Date.now() - started) / 1000, 1e-6);
    const left = (rows.length - done) / Math.max(rate, 1e-6);
    console.log(
      `  ${done.toLocaleString()}/${rows.length.toLocaleString()}  ` +
        `${rate.toFixed(0)}/s  ~${(left / 60).toFixed(0)} min left`
    );
  };

  /**
   * Retry a network call that failed for a reason worth retrying.
   *
   * R2 is a remote host and 217k requests will meet transient failures however
   * healthy the link is; the first run died on a single connect timeout that
   * escaped a worker and rejected the whole pool. Backoff is exponential so a
   * brief outage does not turn into a burst of retries against a host already
   * struggling.
   */
  async function withRetry<T>(what: string, run: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        return await run();
      } catch (error) {
        lastError = error;
        if (attempt === 4) break;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw new Error(`${what}: ${(lastError as Error)?.message ?? lastError}`);
  }

  async function handle(row: AssetRow): Promise<void> {
    const key = bankAssetKey(row.sha256);
    if (!key) {
      // A digest that is not a digest means a corrupt row, not a missing file.
      console.warn(`  ! ${row.sha256?.slice(0, 12)}: not a sha256, skipping`);
      counts.failed += 1;
      return;
    }

    // Content-addressed, so an object already there is byte-identical.
    // Wrapped like every other network call: an unguarded head() was what
    // brought down the first run.
    //
    // --skip-head goes straight to the PUT. Measured round-trip to R2 is ~1.4s,
    // so on a bulk run into an empty bucket the check costs more wall-clock
    // than the upload it is trying to avoid; and because the key is the
    // content digest, re-PUTting writes identical bytes. Worth keeping for
    // top-up runs later, where most rows really are already there.
    if (!args.skipHead) try {
      if (await withRetry('head', () => store.head(key))) {
        counts.skipped += 1;
        return;
      }
    } catch (error) {
      console.error(`  ! ${row.sha256.slice(0, 12)}: ${(error as Error).message}`);
      counts.failed += 1;
      return;
    }

    // relative_path is stored relative to the asset root and already carries
    // its own "assets/sha256/<ab>/" prefix, so it joins on unmodified.
    const file = path.resolve(args.assets, row.relative_path);
    try {
      await stat(file);
    } catch {
      console.warn(`  ! ${row.sha256.slice(0, 12)}: no file at ${file}`);
      counts.missing += 1;
      return;
    }

    if (args.dryRun) {
      counts.uploaded += 1;
      return;
    }

    try {
      const body = await readFile(file);
      await withRetry('put', () => store.put(key, body, { contentType: 'image/png' }));
      counts.uploaded += 1;
      counts.bytes += body.byteLength;
    } catch (error) {
      console.error(`  ! ${row.sha256.slice(0, 12)}: ${(error as Error).message}`);
      counts.failed += 1;
    }
  }

  // A worker pool, not a loop. Each object is around 40 KB, so the cost is one
  // round trip apiece — sequentially that is hours for a corpus this size, and
  // the bandwidth sits idle throughout. Workers pull from a shared cursor so a
  // slow object delays only its own worker.
  const workers = Array.from(
    { length: Math.max(1, Math.min(args.concurrency, rows.length || 1)) },
    async () => {
      while (next < rows.length) {
        const row = rows[next++];
        try {
          await handle(row);
        } catch (error) {
          // A worker must never reject: Promise.all would abandon the other
          // workers mid-flight and lose the run.
          console.error(`  ! ${row.sha256?.slice(0, 12)}: ${(error as Error).message}`);
          counts.failed += 1;
        }
        report();
      }
    }
  );
  await Promise.all(workers);

  database.close();
  console.log(
    `\nuploaded ${counts.uploaded.toLocaleString()}, ` +
      `already present ${counts.skipped.toLocaleString()}, ` +
      `missing locally ${counts.missing}, failed ${counts.failed}` +
      (counts.bytes ? `, ${(counts.bytes / 1e9).toFixed(2)} GB sent` : '') +
      ` in ${((Date.now() - started) / 60000).toFixed(1)} min`
  );

  // A missing file means a question would render a broken image, so this is a
  // non-zero exit even though the rest of the run succeeded.
  if (counts.missing > 0 || counts.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
