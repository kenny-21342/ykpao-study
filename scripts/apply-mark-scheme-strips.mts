/**
 * Give production's published mark schemes the image strips they are missing.
 *
 * WHY THIS EXISTS. A student sees a mark scheme as image strips (or, for
 * multiple choice, a letter) -- `getBankQuestion` returns `strips` and
 * `answerLetter` and never `answerMd`. `apply-mark-scheme-links.mjs` pushed
 * 4,735 relinked IB mark schemes on 29 Sep and moved the *linked* coverage from
 * 59.7% to 80.9%, but it inserted text only (its header says strips were
 * deliberately left out). A mark scheme with text and no strips renders
 * nothing, so the *visible* IB coverage never moved: 12,244 of 20,515, still
 * 59.7%. The rows were in the database and the students could not see them.
 *
 * The strips exist locally. Their `bank_assets` rows are already in production
 * (merge_to_neon.py copies all of them), but the PNG BYTES are mostly not in
 * the bucket: upload-bank-assets.ts only sends assets reachable from rows that
 * were published locally when it ran. Sampled through the live site, 76 of 78
 * of these images failed to load. So this is two steps, in order:
 *
 *   1. upload the PNGs        (scripts/upload-bank-assets.ts --shas <file>)
 *   2. insert the strip rows  (this script)
 *
 *   npx tsx scripts/apply-mark-scheme-strips.mts                       # verify only
 *   npx tsx scripts/apply-mark-scheme-strips.mts --write-shas FILE     # + list the digests to upload
 *   npx tsx scripts/apply-mark-scheme-strips.mts --trial               # insert, report, roll back
 *   npx tsx scripts/apply-mark-scheme-strips.mts --apply               # insert for real
 *
 * ORDER IS ENFORCED, NOT TRUSTED. --trial and --apply HEAD every distinct image
 * in the object store first and REFUSE if any is absent, because a strip row
 * pointing at a missing object is worse than no strip: the student gets a
 * broken image where they previously got a clean "no mark scheme". That check
 * needs the same STORAGE_* variables the upload needs; with the local driver it
 * refuses outright rather than reporting every object missing.
 *
 * INSERT-ONLY AND IDEMPOTENT. Only mark schemes that are published, sit on a
 * published question, and have no strips at all are touched, and each insert is
 * guarded by `NOT EXISTS`. Nothing is updated or deleted, and a re-run finds
 * nothing to do. Mark schemes held back for review stay held back.
 *
 * --apply records every (markSchemeId, ordering) it creates under backups/
 * first. To undo, delete exactly those rows from bank_mark_scheme_strips.
 *
 * Reads DIRECT_DATABASE_URL (falling back to DATABASE_URL); use the non-pooler
 * endpoint -- this holds one session across thousands of inserts.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';

import { pgConfig } from '../lib/db-ssl';
import { getStorage } from '../lib/storage/index';
import { bankAssetKey } from '../lib/storage/keys';

const args = process.argv.slice(2);
const trial = args.includes('--trial');
const apply = args.includes('--apply') || trial;
const shasIdx = args.indexOf('--write-shas');
const shasPath = shasIdx >= 0 ? args[shasIdx + 1] : null;
const sourceIdx = args.indexOf('--source');
const sourcePath = sourceIdx >= 0 && args[sourceIdx + 1] ? args[sourceIdx + 1] : 'pdf_extraction/bank/extract.db';
const skipStorageCheck = args.includes('--no-storage-check');

const BATCH = 1000;
const HEAD_CONCURRENCY = 16;

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('Set DIRECT_DATABASE_URL (or DATABASE_URL) first.');
  process.exit(1);
}
if (url.includes('-pooler')) {
  console.error('That is the pooled endpoint. Use the direct one (drop "-pooler" from the host).');
  process.exit(1);
}

type Strip = { sha: string; ordering: number; page: number };
type Target = { markSchemeId: number; board: string; strips: Strip[] };

const src = new Database(sourcePath, { readonly: true });
const client = new pg.Client(pgConfig(url));

/** What a student can actually open: published, and strips or an MCQ letter. */
const visibleCoverage = async () => {
  const { rows } = await client.query(`
    SELECT p.board,
           count(*)::int AS questions,
           count(*) FILTER (WHERE ms.status = 'published' AND (
             coalesce(btrim(ms."answerLetter"), '') <> ''
             OR EXISTS (SELECT 1 FROM bank_mark_scheme_strips s WHERE s."markSchemeId" = ms.id)
           ))::int AS visible
    FROM bank_questions bq
    JOIN bank_papers p ON p.id = bq."paperId"
    LEFT JOIN bank_mark_schemes ms ON ms."questionId" = bq.id
    WHERE bq.status = 'published'
    GROUP BY p.board ORDER BY p.board
  `);
  return rows as { board: string; questions: number; visible: number }[];
};

const report = (rows: { board: string; questions: number; visible: number }[], label: string) => {
  console.log(`${label}:`);
  for (const r of rows) {
    console.log(
      `  ${r.board.padEnd(5)} ${String(r.visible).padStart(6)} / ${String(r.questions).padStart(6)}  ` +
        `${((100 * r.visible) / r.questions).toFixed(1)}% of questions show a mark scheme`,
    );
  }
};

try {
  await client.connect();
  console.log(`connected: ${url.replace(/\/\/[^@]*@/, '//***@')}`);
  console.log(`source:    ${sourcePath}\n`);
  report(await visibleCoverage(), 'BEFORE');

  // Published mark schemes on published questions that show nothing: no letter
  // and no strips. Keyed the same way every other apply-* script keys them.
  const { rows: empty } = await client.query(`
    SELECT ms.id AS ms_id, p."sourcePath" AS source_path, ms."rootNumber" AS root, p.board
    FROM bank_mark_schemes ms
    JOIN bank_questions bq ON bq.id = ms."questionId" AND bq.status = 'published'
    JOIN bank_papers p ON p.id = bq."paperId"
    WHERE ms.status = 'published'
      AND coalesce(btrim(ms."answerLetter"), '') = ''
      AND NOT EXISTS (SELECT 1 FROM bank_mark_scheme_strips s WHERE s."markSchemeId" = ms.id)
  `);

  const { rows: assetRows } = await client.query('SELECT id, sha256 FROM bank_assets');
  const assetId = new Map<string, number>(assetRows.map((r) => [r.sha256 as string, r.id as number]));

  const localRows = src.prepare(`
    SELECT qp.source_path AS source_path, q.root_number AS root,
           s.ordering AS ordering, s.page AS page, a.sha256 AS sha
    FROM bank_mark_schemes ms
    JOIN bank_questions q ON q.id = ms.question_id
    JOIN bank_papers qp ON qp.id = q.paper_id
    JOIN bank_mark_scheme_strips s ON s.mark_scheme_id = ms.id
    JOIN bank_assets a ON a.id = s.asset_id
    ORDER BY qp.source_path, q.root_number, s.ordering
  `).all() as { source_path: string; root: number; ordering: number; page: number; sha: string }[];
  const localStrips = new Map<string, Strip[]>();
  for (const row of localRows) {
    const key = `${row.source_path}#${row.root}`;
    const list = localStrips.get(key) ?? [];
    list.push({ sha: row.sha, ordering: row.ordering, page: row.page });
    localStrips.set(key, list);
  }

  const targets: Target[] = [];
  let noLocalStrips = 0;
  let assetNotInProduction = 0;
  for (const row of empty) {
    const strips = localStrips.get(`${row.source_path}#${row.root}`);
    if (!strips) { noLocalStrips += 1; continue; }
    // Every strip or none: a mark scheme showing half its pages is worse than
    // showing none, because it looks complete.
    if (strips.some((strip) => !assetId.has(strip.sha))) { assetNotInProduction += 1; continue; }
    targets.push({ markSchemeId: row.ms_id, board: row.board, strips });
  }

  const digests = [...new Set(targets.flatMap((t) => t.strips.map((s) => s.sha)))].sort();
  const byBoard = targets.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.board]: (acc[t.board] ?? 0) + 1 }), {});

  console.log(`\npublished mark schemes that show nothing: ${empty.length.toLocaleString()}`);
  console.log(`  ${targets.length.toLocaleString()} can be fixed (${Object.entries(byBoard).map(([b, n]) => `${b} ${n.toLocaleString()}`).join(', ')})`);
  console.log(`  ${noLocalStrips.toLocaleString()} have no strips in the local store either`);
  console.log(`  ${assetNotInProduction.toLocaleString()} reference an image row production does not have (left alone)`);
  console.log(`  ${targets.reduce((n, t) => n + t.strips.length, 0).toLocaleString()} strip rows, ${digests.length.toLocaleString()} distinct images`);

  if (shasPath) {
    mkdirSync(join(shasPath, '..'), { recursive: true });
    writeFileSync(shasPath, digests.join('\n') + '\n');
    console.log(`\nwrote ${digests.length.toLocaleString()} digests to ${shasPath}`);
    console.log(`next: STORAGE_* set, then  npx tsx scripts/upload-bank-assets.ts --shas ${shasPath}`);
  }

  if (!apply) {
    console.log('\nVerification only. Upload the images, then re-run with --apply.');
    process.exit(0);
  }
  if (targets.length === 0) {
    console.log('\nNothing to insert.');
    process.exit(0);
  }

  // ---- the ordering guard: never reference an object that is not there ----
  if (skipStorageCheck) {
    console.warn('\n!! --no-storage-check: NOT confirming the images exist. Strips for missing images will render broken.');
  } else {
    if ((process.env.STORAGE_DRIVER ?? 'local').toLowerCase() !== 's3') {
      console.error(
        '\nRefusing: STORAGE_DRIVER is not "s3", so the object store cannot be checked and every image would\n' +
          'look missing. Set the STORAGE_* variables (the same ones upload-bank-assets.ts needs).',
      );
      process.exitCode = 1;
      process.exit();
    }
    const store = getStorage();
    console.log(`\nconfirming ${digests.length.toLocaleString()} images exist in the object store...`);
    const absent: string[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: HEAD_CONCURRENCY }, async () => {
      while (next < digests.length) {
        const sha = digests[next++];
        const key = bankAssetKey(sha);
        const meta = key ? await store.head(key).catch(() => null) : null;
        if (!meta) absent.push(sha);
      }
    }));
    if (absent.length > 0) {
      console.error(`\nRefusing: ${absent.length.toLocaleString()} of ${digests.length.toLocaleString()} images are not in the object store (e.g. ${absent[0].slice(0, 16)}).`);
      console.error('Upload them first:  npx tsx scripts/upload-bank-assets.ts --shas <the file from --write-shas>');
      console.error('(A 403 on every one means the STORAGE_* credentials are wrong or stale, not that the files are missing.)');
      process.exitCode = 1;
      process.exit();
    }
    console.log('  all present.');
  }

  const stripCount = targets.reduce((n, t) => n + t.strips.length, 0);
  if (trial) {
    await client.query('BEGIN');
    console.log('\n--trial: inserting inside a transaction that will be rolled back.');
  } else {
    mkdirSync('backups', { recursive: true });
    const backupPath = join('backups', `mark-scheme-strips-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    writeFileSync(
      backupPath,
      targets.flatMap((t) => t.strips.map((s) => JSON.stringify({ markSchemeId: t.markSchemeId, ordering: s.ordering }))).join('\n') + '\n',
    );
    console.log(`\nbackup: ${backupPath} (${stripCount.toLocaleString()} rows about to be created)`);
    console.log('To undo: DELETE FROM bank_mark_scheme_strips for exactly the (markSchemeId, ordering) pairs in that file.');
  }

  const flat = targets.flatMap((t) => t.strips.map((s) => ({ ms: t.markSchemeId, asset: assetId.get(s.sha)!, ordering: s.ordering, page: s.page })));
  let inserted = 0;
  for (let offset = 0; offset < flat.length; offset += BATCH) {
    const slice = flat.slice(offset, offset + BATCH);
    const params: number[] = [];
    const values = slice.map((row, i) => {
      params.push(row.ms, row.asset, row.ordering, row.page);
      const b = i * 4;
      return `($${b + 1}::int,$${b + 2}::int,$${b + 3}::int,$${b + 4}::int)`;
    });
    const { rowCount } = await client.query(
      `INSERT INTO bank_mark_scheme_strips ("markSchemeId","assetId","ordering","page")
       SELECT v.* FROM (VALUES ${values.join(',')}) AS v("markSchemeId","assetId","ordering","page")
       WHERE NOT EXISTS (SELECT 1 FROM bank_mark_scheme_strips x WHERE x."markSchemeId" = v."markSchemeId" AND x."ordering" = v."ordering")
       ON CONFLICT DO NOTHING`,
      params,
    );
    inserted += rowCount ?? 0;
    process.stdout.write(`\r  inserted ${inserted.toLocaleString()} / ${flat.length.toLocaleString()}`);
  }
  console.log('\n');
  report(await visibleCoverage(), trial ? 'AFTER (trial, about to roll back)' : 'AFTER');
  if (trial) {
    await client.query('ROLLBACK');
    console.log('\nrolled back -- production is unchanged.');
  }
} catch (error) {
  console.error('\nFailed:', (error as Error).message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
  src.close();
}
