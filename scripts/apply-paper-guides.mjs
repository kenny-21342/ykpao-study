/**
 * Push paper-level marking guidance (bank_paper_guides) to production.
 *
 * pdf_extraction/bank/build_paper_guides.py renders each mark-scheme PDF's pages
 * and records them against the question paper. This copies those rows across:
 * it matches each local question paper to production by sourcePath, inserts any
 * page image production does not know yet, and inserts the guide rows. Insert
 * only; existing guide rows are never changed.
 *
 *   node --env-file=.env.neon --env-file=.env --env-file=.env.r2 scripts/apply-paper-guides.mjs           # verify + check bucket
 *   node ... scripts/apply-paper-guides.mjs --trial   # insert, report, roll back
 *   node ... scripts/apply-paper-guides.mjs --apply   # back up ids, then insert
 *
 * The page images must already be in the bucket (upload them first with
 *   scripts/upload-bank-assets.ts --shas FILE   -- `--write-shas FILE` writes the list),
 * otherwise a student would be shown broken images. This refuses to insert until
 * every image is confirmed present. Needs the 20261121090000_bank_paper_guides
 * migration applied (`prisma migrate deploy`).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import pg from 'pg';

import { pgConfig } from '../lib/db-ssl.ts';
import { getStorage, storageDriver } from '../lib/storage/index.ts';
import { bankAssetKey } from '../lib/storage/keys.ts';

const args = process.argv.slice(2);
const trial = args.includes('--trial');
const apply = args.includes('--apply') || trial;
const shasIdx = args.indexOf('--write-shas');
const shasPath = shasIdx >= 0 ? args[shasIdx + 1] : null;

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('Set DIRECT_DATABASE_URL (or DATABASE_URL) first.');
  process.exit(1);
}

const src = new Database('pdf_extraction/bank/extract.db', { readonly: true });
const client = new pg.Client(pgConfig(url));
client.on('error', (error) => console.warn(`  (database connection dropped: ${error.message})`));
await client.connect();

try {
  const local = src
    .prepare(
      `SELECT p.source_path AS path, g.ordering, g.page, a.sha256, a.kind, a.relative_path, a.width, a.height,
              a.byte_size, a.source_page, a.bbox, a.source_dpi
         FROM bank_paper_guides g
         JOIN bank_papers p ON p.id = g.paper_id
         JOIN bank_assets a ON a.id = g.asset_id
        ORDER BY p.id, g.ordering`,
    )
    .all();
  const { rows: papers } = await client.query('SELECT id, "sourcePath" FROM bank_papers');
  const paperId = new Map(papers.map((r) => [r.sourcePath, r.id]));
  const { rows: existing } = await client.query('SELECT DISTINCT "paperId" FROM bank_paper_guides');
  const hasGuide = new Set(existing.map((r) => r.paperId));

  const targets = [];
  let notInProduction = 0;
  let alreadyDone = 0;
  const seenPaper = new Set();
  for (const row of local) {
    const id = paperId.get(row.path);
    if (id === undefined) {
      if (!seenPaper.has(row.path)) notInProduction += 1;
      seenPaper.add(row.path);
      continue;
    }
    if (hasGuide.has(id)) {
      if (!seenPaper.has(row.path)) alreadyDone += 1;
      seenPaper.add(row.path);
      continue;
    }
    seenPaper.add(row.path);
    targets.push({ ...row, paperId: id });
  }
  const shas = [...new Set(targets.map((t) => t.sha256))];
  const guidePapers = new Set(targets.map((t) => t.paperId));
  console.log(`local guide rows: ${local.length.toLocaleString()}`);
  console.log(`  ${notInProduction} question papers are not in production (skipped)`);
  console.log(`  ${alreadyDone} already have a guide in production (left alone)`);
  console.log(`  ${guidePapers.size} question papers would get a guide: ${targets.length.toLocaleString()} rows, ${shas.length.toLocaleString()} distinct page images`);

  if (shasPath) {
    writeFileSync(shasPath, shas.join('\n') + '\n');
    console.log(`wrote ${shas.length} digests to ${shasPath}`);
    console.log(`next: node --env-file=.env.neon --env-file=.env --env-file=.env.r2 --import tsx scripts/upload-bank-assets.ts --shas ${shasPath}`);
  }

  if (storageDriver() !== 's3') {
    console.error('\nSTORAGE_DRIVER is not "s3": cannot confirm the images are in the bucket. Add --env-file=.env.r2.');
    process.exit(1);
  }
  const store = getStorage();
  console.log(`\nconfirming ${shas.length.toLocaleString()} page images exist in the object store...`);
  const absent = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (next < shas.length) {
        const sha = shas[next++];
        const key = bankAssetKey(sha);
        let meta = null;
        // A timeout is not proof of absence: retry errors, count only a clean "not found".
        for (let attempt = 0; key && attempt < 4; attempt++) {
          try {
            meta = await store.head(key);
            break;
          } catch {
            /* retry */
          }
        }
        if (!meta) absent.push(sha);
      }
    }),
  );
  if (absent.length > 0) {
    console.error(`\nRefusing: ${absent.length} of ${shas.length} page images are not in the object store (e.g. ${absent[0].slice(0, 16)}).`);
    console.error('Upload them first with scripts/upload-bank-assets.ts --shas <file from --write-shas>.');
    process.exit(1);
  }
  console.log('  all present.');

  if (!apply) {
    console.log('\nVerification only. Re-run with --trial, then --apply.');
  } else {
    await client.query('BEGIN');
    // Assets first: production may never have seen these page images.
    const have = new Set();
    for (let i = 0; i < shas.length; i += 1000) {
      const { rows } = await client.query('SELECT sha256 FROM bank_assets WHERE sha256 = ANY($1::text[])', [shas.slice(i, i + 1000)]);
      rows.forEach((r) => have.add(r.sha256));
    }
    const newAssets = [...new Map(targets.filter((t) => !have.has(t.sha256)).map((t) => [t.sha256, t])).values()];
    for (let i = 0; i < newAssets.length; i += 500) {
      const part = newAssets.slice(i, i + 500);
      const values = [];
      const marks = part.map((a, j) => {
        values.push(a.sha256, a.kind, a.relative_path, a.width, a.height, a.byte_size, a.source_page, a.bbox, a.source_dpi ?? 200);
        const b = j * 9;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`;
      });
      await client.query(
        `INSERT INTO bank_assets (sha256, kind, "relativePath", width, height, "byteSize", "sourcePage", bbox, "sourceDpi")
         VALUES ${marks.join(',')} ON CONFLICT (sha256) DO NOTHING`,
        values,
      );
    }
    console.log(`  inserted ${newAssets.length} page-image rows`);
    const idBySha = new Map();
    for (let i = 0; i < shas.length; i += 1000) {
      const { rows } = await client.query('SELECT id, sha256 FROM bank_assets WHERE sha256 = ANY($1::text[])', [shas.slice(i, i + 1000)]);
      rows.forEach((r) => idBySha.set(r.sha256, r.id));
    }

    if (!trial) {
      if (!existsSync('backups')) mkdirSync('backups');
      const path = `backups/paper-guides-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      writeFileSync(path, JSON.stringify([...guidePapers]));
      console.log(`backup: ${path} (${guidePapers.size} paper ids about to get guides)`);
      console.log('To undo: DELETE FROM bank_paper_guides WHERE "paperId" IN (<the ids in that file>);');
    }
    let inserted = 0;
    for (let i = 0; i < targets.length; i += 1000) {
      const part = targets.slice(i, i + 1000);
      const values = [];
      const marks = part.map((t, j) => {
        values.push(t.paperId, t.ordering, idBySha.get(t.sha256), t.page);
        const b = j * 4;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4})`;
      });
      const res = await client.query(
        `INSERT INTO bank_paper_guides ("paperId", ordering, "assetId", page) VALUES ${marks.join(',')} ON CONFLICT DO NOTHING`,
        values,
      );
      inserted += res.rowCount ?? 0;
    }
    console.log(`  inserted ${inserted} guide rows for ${guidePapers.size} papers`);
    if (trial) {
      await client.query('ROLLBACK');
      console.log('\nrolled back -- production is unchanged.');
    } else {
      await client.query('COMMIT');
      console.log('\ncommitted.');
    }
  }
} finally {
  await client.end();
}
