/**
 * Remove duplicate open review flags from production.
 *
 * The 17 Nov merge inserted flags that production already held, so the same
 * (question, paper, issue, message) can appear several times. Only exact
 * duplicates among OPEN flags are removed: the lowest id of each group stays.
 *
 *   node --env-file=.env scripts/dedupe-review-flags.mjs           # report only
 *   node --env-file=.env scripts/dedupe-review-flags.mjs --apply   # back up, then delete
 *
 * Deleted rows are written in full to backups/review-flags-dupes-*.jsonl first.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { pgConfig } from '../lib/db-ssl.ts';

const apply = process.argv.includes('--apply');
const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('Set DIRECT_DATABASE_URL first.'); process.exit(1); }
const client = new pg.Client(pgConfig(url));
await client.connect();
try {
  const { rows: cols } = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'bank_review_flags'`);
  console.log('columns:', cols.map((c) => c.column_name).join(', '));
  const key = `COALESCE("questionId", -1), COALESCE("paperId", -1), "issueType", message`;
  const { rows } = await client.query(
    `SELECT count(*) AS open_flags,
            count(*) - count(DISTINCT (${key})) AS duplicates
       FROM bank_review_flags WHERE status = 'open'`);
  console.log(rows[0]);
  const dupIds = await client.query(
    `SELECT id FROM (
       SELECT id, row_number() OVER (PARTITION BY ${key} ORDER BY id) AS rn
         FROM bank_review_flags WHERE status = 'open') t WHERE rn > 1`);
  console.log(`${dupIds.rowCount} exact duplicate open flags would be removed`);
  if (apply && dupIds.rowCount) {
    if (!existsSync('backups')) mkdirSync('backups');
    const path = `backups/review-flags-dupes-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    const ids = dupIds.rows.map((r) => r.id);
    const full = await client.query(`SELECT * FROM bank_review_flags WHERE id = ANY($1::int[])`, [ids]);
    writeFileSync(path, full.rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`backup: ${path} (${full.rowCount} rows)`);
    let deleted = 0;
    for (let i = 0; i < ids.length; i += 2000) {
      const res = await client.query(`DELETE FROM bank_review_flags WHERE id = ANY($1::int[])`, [ids.slice(i, i + 2000)]);
      deleted += res.rowCount ?? 0;
    }
    console.log(`deleted ${deleted}`);
  } else if (!apply) console.log('Report only. Re-run with --apply.');
} finally { await client.end(); }
