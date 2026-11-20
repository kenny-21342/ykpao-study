/**
 * Publish questions whose only blocker was a model-confidence flag at or above
 * a threshold. Candidates are chosen locally (see the id list file); this maps
 * them to production by (paper sourcePath, root number), records the current
 * status of every row it touches in backups/, and only changes
 * 'needs_review' -> 'published'.
 *
 *   node --env-file=.env scripts/publish-lowconf.mjs ids.json            # report
 *   node --env-file=.env scripts/publish-lowconf.mjs ids.json --apply
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import pg from 'pg';
import { pgConfig } from '../lib/db-ssl.ts';

const ids = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const apply = process.argv.includes('--apply');
const local = new Database('pdf_extraction/bank/extract.db', { readonly: true });
const rows = local.prepare(
  `SELECT q.id, q.root_number AS root, p.source_path AS path FROM bank_questions q
     JOIN bank_papers p ON p.id = q.paper_id WHERE q.id IN (${ids.map(() => '?').join(',')})`,
).all(...ids);
const client = new pg.Client(pgConfig(process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL));
await client.connect();
try {
  const found = [];
  for (const r of rows) {
    const { rows: hit } = await client.query(
      `SELECT q.id, q.status FROM bank_questions q JOIN bank_papers p ON p.id = q."paperId"
        WHERE p."sourcePath" = $1 AND q."rootNumber" = $2`, [r.path, r.root]);
    if (hit.length === 1) found.push(hit[0]);
  }
  const todo = found.filter((f) => f.status === 'needs_review');
  console.log(`${rows.length} candidates, ${found.length} found in production, ${todo.length} currently needs_review`);
  if (apply && todo.length) {
    if (!existsSync('backups')) mkdirSync('backups');
    const path = `backups/publish-lowconf-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(path, JSON.stringify(found));
    const res = await client.query(`UPDATE bank_questions SET status = 'published' WHERE id = ANY($1::int[]) AND status = 'needs_review'`, [todo.map((t) => t.id)]);
    console.log(`backup ${path}; published ${res.rowCount}`);
  } else if (!apply) console.log('Report only.');
} finally { await client.end(); }
