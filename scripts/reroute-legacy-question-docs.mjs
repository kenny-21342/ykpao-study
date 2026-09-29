/**
 * Point the legacy past-paper question documents at the paper they came from.
 *
 * These are the `past-paper-question:` documents for the 12,398-row text
 * corpus. They were written with `route = /?tab=questions-db&qid=...`, which
 * opens the legacy browser the platform no longer practises on -- a student
 * could land there from nothing more than a search result.
 *
 * The first plan was to delete them. That was wrong: all 12,398 carry real
 * extracted text, so removing them would have made a corpus that took weeks to
 * build unfindable, in order to remove a link. Every one of the 714 papers
 * behind them has a file, so `/papers/[id]` is a real destination -- the
 * question stays searchable and the click lands on the actual paper.
 *
 * The id is read from `metadata->>'paperId'`, which every one of the 12,398
 * documents carries, so no join is needed and a row without it is skipped
 * rather than given a broken route.
 *
 *   node scripts/reroute-legacy-question-docs.mjs            # count + back up, changes nothing
 *   node scripts/reroute-legacy-question-docs.mjs --apply    # count, back up, then update
 *
 * Both modes write the backup first. It lands in `backups/` (gitignored) as
 * JSONL of {id, documentKey, route}, which is everything needed to put the old
 * routes back:
 *
 *   node scripts/reroute-legacy-question-docs.mjs --restore backups/<file>.jsonl
 *
 * This is an UPDATE, not a DELETE -- no row is removed and no text is touched,
 * only the `route` column.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import pg from 'pg';

import { pgConfig } from '../lib/db-ssl.ts';

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
const restoreIdx = process.argv.indexOf('--restore');
const restoreFrom = restoreIdx >= 0 ? process.argv[restoreIdx + 1] : null;
const PREFIX = 'past-paper-question:%';

const client = new pg.Client(pgConfig(url));
await client.connect();
try {
  if (restoreFrom) {
    const rows = readFileSync(restoreFrom, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let restored = 0;
    for (const row of rows) {
      const r = await client.query(`UPDATE rag_documents SET route = $1 WHERE id = $2`, [row.route, row.id]);
      restored += r.rowCount;
    }
    console.log(`restored ${restored.toLocaleString()} routes from ${restoreFrom}`);
  } else {
    const { rows } = await client.query(
      `SELECT id, "documentKey", route, metadata->>'paperId' AS paper_id
       FROM rag_documents
       WHERE "documentKey" LIKE $1
       ORDER BY "documentKey"`,
      [PREFIX],
    );
    const withPaper = rows.filter((r) => r.paper_id);
    const already = rows.filter((r) => r.route && r.route.startsWith('/papers/'));

    // Back up before anything else, in both modes. A backup taken only on
    // --apply is a backup you do not have when you find out you needed one.
    mkdirSync(join(process.cwd(), 'backups'), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = join(process.cwd(), 'backups', `legacy-question-routes-${stamp}.jsonl`);
    writeFileSync(backup, rows.map((r) => JSON.stringify({ id: r.id, documentKey: r.documentKey, route: r.route })).join('\n') + '\n');

    console.log(`legacy question documents : ${rows.length.toLocaleString()}`);
    console.log(`  carry a paperId         : ${withPaper.length.toLocaleString()}`);
    console.log(`  already re-routed       : ${already.length.toLocaleString()}`);
    console.log(`backup written            : ${backup}`);

    if (!apply) {
      console.log('\nCount and backup only. Re-run with --apply to update the route column.');
    } else {
      const updated = await client.query(
        `UPDATE rag_documents
            SET route = '/papers/' || (metadata->>'paperId')
          WHERE "documentKey" LIKE $1
            AND metadata->>'paperId' IS NOT NULL`,
        [PREFIX],
      );
      const { rows: [after] } = await client.query(
        `SELECT count(*) FILTER (WHERE route LIKE '/papers/%')::int repointed,
                count(*) FILTER (WHERE route LIKE '/?tab=questions-db%')::int still_old,
                count(*)::int total
           FROM rag_documents WHERE "documentKey" LIKE $1`,
        [PREFIX],
      );
      console.log(`\nupdated                   : ${updated.rowCount.toLocaleString()} rows`);
      console.log(`now routed at /papers/    : ${after.repointed.toLocaleString()}`);
      console.log(`still on the old route    : ${after.still_old}`);
      console.log(`total (unchanged count)   : ${after.total.toLocaleString()}`);
      console.log(`\nto undo: node scripts/reroute-legacy-question-docs.mjs --restore ${backup}`);
    }
  }
} finally {
  await client.end();
}
