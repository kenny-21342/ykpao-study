/**
 * Push the deterministically-read mark totals to production.
 *
 * `merge_to_neon.py` cannot do this. It is insert-only: every question is
 * already in Postgres, so its `ON CONFLICT ("paperId","rootNumber") DO NOTHING`
 * skips them all and reports success having written nothing.
 *
 * `prisma db execute` cannot do it either -- it runs a script but shows no
 * rows, so there is no way to see the verification or the number of rows
 * changed. Hence this: same two SQL files, with output.
 *
 *   node scripts/apply-mark-totals.mjs            # verify only, writes nothing
 *   node scripts/apply-mark-totals.mjs --apply    # verify, then update
 *
 * Reads DIRECT_DATABASE_URL, falling back to DATABASE_URL. Use the direct
 * (non `-pooler`) endpoint: this is one transaction over ~7,000 rows and the
 * transaction pooler is the wrong place for it.
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('Set DIRECT_DATABASE_URL (or DATABASE_URL) first.');
  process.exit(1);
}
if (url.includes('-pooler')) {
  console.error('That is the pooled endpoint. Use the direct one (drop "-pooler" from the host).');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const client = new pg.Client({ connectionString: url });

const show = (rows) => {
  if (!rows.length) return console.log('  (no rows)');
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  console.log('  ' + cols.map((c, i) => c.padEnd(w[i])).join('  '));
  console.log('  ' + w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) {
    console.log('  ' + cols.map((c, i) => String(r[c]).padEnd(w[i])).join('  '));
  }
};

try {
  await client.connect();
  console.log(`connected: ${url.replace(/\/\/[^@]*@/, '//***@')}\n`);

  console.log('BEFORE');
  const before = await client.query(
    readFileSync('prisma/manual/2026-08-29_verify_mark_totals.sql', 'utf8'),
  );
  show(before.rows);

  if (!apply) {
    console.log('\nVerification only. Re-run with --apply to write.');
    process.exit(0);
  }

  // The file carries its own BEGIN/COMMIT and an `IS NULL` guard, so a re-run
  // is a no-op rather than a second write.
  const sql = readFileSync('prisma/manual/2026-08-29_question_mark_totals.sql', 'utf8');
  console.log(`\napplying ${(sql.length / 1024).toFixed(0)} KB ...`);
  const result = await client.query(sql);
  const updated = (Array.isArray(result) ? result : [result])
    .reduce((n, r) => n + (r?.rowCount ?? 0), 0);
  console.log(`rows updated: ${updated}`);

  console.log('\nAFTER');
  const after = await client.query(
    readFileSync('prisma/manual/2026-08-29_verify_mark_totals.sql', 'utf8'),
  );
  show(after.rows);
} catch (error) {
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
