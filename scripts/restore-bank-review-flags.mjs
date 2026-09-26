#!/usr/bin/env node
/**
 * Restore `bank_review_flags` from an NDJSON dump taken before the
 * 20260923150000_deduplicate_bank_review_flags migration deleted 38,484
 * duplicate rows on 26 Sep 2026.
 *
 * The dump itself lives outside the repo (~/smart-edu-backups) because it is
 * 26MB of data; this script is the code that reads it. Run from the project
 * root, which is also where the SSL settings in the connection string resolve:
 *   npx tsx -r dotenv/config scripts/restore-bank-review-flags.mjs <dump.ndjson> [--apply]
 *
 * Without --apply it reports what it would insert and changes nothing.
 * Inserts are ON CONFLICT (id) DO NOTHING, so re-running is a no-op and rows
 * that still exist are never overwritten. Note the migration also creates a
 * UNIQUE index on the content digest: restoring the duplicates requires
 * dropping `bank_review_flags_identity_idx` first, or the inserts will fail.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
// Aiven presents a per-project CA, so the connection string alone is not enough
// -- the older scripts here predate Aiven and still assume a public CA.
import { pgConfig } from '../lib/db-ssl.ts';

const [file, ...flags] = process.argv.slice(2);
if (!file) { console.error('usage: restore-bank-review-flags.mjs <dump.ndjson> [--apply]'); process.exit(2); }
const apply = flags.includes('--apply');

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('DIRECT_DATABASE_URL or DATABASE_URL must be set'); process.exit(2); }
if (url.includes('-pooler')) { console.error('refusing to run through a pooler; use the direct URL'); process.exit(2); }

const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const COLUMNS = ['id', 'questionId', 'paperId', 'issueType', 'severity', 'message', 'evidence', 'status', 'createdAt', 'reviewedBy', 'reviewedAt', 'reviewNote'];

const client = new pg.Client({ ...pgConfig(url), connectionTimeoutMillis: 15000 });
await client.connect();
const before = (await client.query('select count(*)::int n from bank_review_flags')).rows[0].n;
console.log(`dump holds ${rows.length} rows; table currently holds ${before}`);

if (!apply) {
  const ids = rows.map((r) => r.id);
  const present = (await client.query('select id from bank_review_flags where id = any($1::int[])', [ids])).rows.length;
  console.log(`would insert ${rows.length - present} rows (${present} already present). Re-run with --apply.`);
  await client.end();
  process.exit(0);
}

const placeholders = COLUMNS.map((_, i) => `$${i + 1}`).join(', ');
const sql = `INSERT INTO bank_review_flags (${COLUMNS.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`;
let inserted = 0;
await client.query('BEGIN');
try {
  for (const row of rows) {
    const result = await client.query(sql, COLUMNS.map((c) => row[c] ?? null));
    inserted += result.rowCount;
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  console.error('rolled back:', error.message);
  process.exit(1);
}
const after = (await client.query('select count(*)::int n from bank_review_flags')).rows[0].n;
console.log(`inserted ${inserted}; table now holds ${after}`);
await client.query(`SELECT setval(pg_get_serial_sequence('bank_review_flags','id'), (SELECT MAX(id) FROM bank_review_flags))`);
await client.end();
