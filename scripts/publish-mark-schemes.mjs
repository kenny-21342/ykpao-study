/**
 * Publish mark schemes that production holds as needs_review but the local
 * store has since promoted (text present, confidence >= 0.60, unflagged, on a
 * published question). The app hides any scheme whose status is not
 * 'published'. Matches by (question paper sourcePath, rootNumber); records the
 * previous status of every row it touches under backups/.
 *
 *   node --env-file=.env scripts/publish-mark-schemes.mjs ids.json [--apply]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import pg from 'pg';
import { pgConfig } from '../lib/db-ssl.ts';

const ids = JSON.parse(readFileSync(process.argv[2], 'utf8')).map((r) => r[0]);
const apply = process.argv.includes('--apply');
const local = new Database('pdf_extraction/bank/extract.db', { readonly: true });
const rows = [];
for (let i = 0; i < ids.length; i += 500) {
  const part = ids.slice(i, i + 500);
  rows.push(...local.prepare(
    `SELECT m.id, q.root_number AS root, p.source_path AS path FROM bank_mark_schemes m
       JOIN bank_questions q ON q.id = m.question_id JOIN bank_papers p ON p.id = q.paper_id
      WHERE m.id IN (${part.map(() => '?').join(',')})`).all(...part));
}
const client = new pg.Client(pgConfig(process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL));
await client.connect();
try {
  const found = [];
  for (const r of rows) {
    const { rows: hit } = await client.query(
      `SELECT m.id, m.status FROM bank_mark_schemes m JOIN bank_questions q ON q.id = m."questionId"
         JOIN bank_papers p ON p.id = q."paperId" WHERE p."sourcePath" = $1 AND q."rootNumber" = $2`, [r.path, r.root]);
    if (hit.length === 1) found.push(hit[0]);
  }
  const todo = found.filter((f) => f.status !== 'published');
  console.log(`${rows.length} local rows, ${found.length} found in production, ${todo.length} not yet published`);
  if (apply && todo.length) {
    if (!existsSync('backups')) mkdirSync('backups');
    const path = `backups/publish-mark-schemes-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    writeFileSync(path, JSON.stringify(found));
    const res = await client.query(`UPDATE bank_mark_schemes SET status = 'published' WHERE id = ANY($1::int[]) AND status <> 'published'`, [todo.map((t) => t.id)]);
    console.log(`backup ${path}; published ${res.rowCount}`);
  } else if (!apply) console.log('Report only.');
} finally { await client.end(); }
