/**
 * Push sub-part data from the local extraction store to production.
 *
 * Two independent steps, both additive:
 *
 *   json  Fill `bank_questions.parts` ([{"label":"a(i)","marks":3}, ...]) from the
 *         layout-derived labels and marks held locally. Production has '[]' for
 *         every published row, while 22,153 published questions have them
 *         locally. Costs nothing. Only rows still at '[]' are written.
 *
 *   rows  Insert the per-part topic and difficulty rows from the local
 *         `bank_question_parts` table (written by
 *         `python3 -m pdf_extraction.bank.tag_parts`) into production's
 *         `bank_question_parts`. Needs migration 20261016120000 applied first.
 *
 *   node scripts/apply-parts.mjs                    # verify both, write nothing
 *   node scripts/apply-parts.mjs --trial            # a few batches, then roll back
 *   node scripts/apply-parts.mjs --apply            # write both
 *   node scripts/apply-parts.mjs --apply --only json
 *   node scripts/apply-parts.mjs --apply --only rows
 *   node scripts/apply-parts.mjs --refresh          # rows: also update ones already present
 *
 * Reads DIRECT_DATABASE_URL, falling back to DATABASE_URL (the direct, non
 * `-pooler` endpoint). --apply commits batch by batch and is resumable;
 * --trial runs the first few batches inside a transaction and rolls back.
 * Everything --apply creates or changes is appended to backups/parts-<ts>.jsonl.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';

import { pgConfig } from '../lib/db-ssl.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const trial = args.includes('--trial');
const refresh = args.includes('--refresh');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : 'both';
const sourceIdx = args.indexOf('--source');
const sourcePath = sourceIdx >= 0 && args[sourceIdx + 1] ? args[sourceIdx + 1] : 'pdf_extraction/bank/extract.db';
const BATCH = 500;

if (!['both', 'json', 'rows'].includes(only)) {
  console.error('--only must be json, rows or both');
  process.exit(1);
}
const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('Set DIRECT_DATABASE_URL (or DATABASE_URL) first.'); process.exit(1); }
if (url.includes('-pooler')) { console.error('That is the pooled endpoint. Use the direct one (drop "-pooler" from the host).'); process.exit(1); }
if (!existsSync(sourcePath)) { console.error(`Source SQLite not found: ${sourcePath}`); process.exit(1); }

const src = new Database(sourcePath, { readonly: true });
const client = new pg.Client({ ...pgConfig(url), connectionTimeoutMillis: 30_000, keepAlive: true });
client.on('error', (error) => console.error(`\n(connection error: ${error.message})`));
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const fmt = (value) => Number(value).toLocaleString();

const backupPath = join('backups', `parts-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const record = (entry) => { if (apply) appendFileSync(backupPath, JSON.stringify(entry) + '\n'); };
const sample = trial ? 3 : Infinity;

try {
  log('connecting (gives up after 30 s)...');
  await client.connect();
  console.log(`connected: ${url.replace(/\/\/[^@]*@/, '//***@')}\nsource:    ${sourcePath}\n`);
  if (apply) mkdirSync('backups', { recursive: true });

  log('reading production paper and question ids...');
  const { rows: paperRows } = await client.query('SELECT id, "sourcePath" FROM bank_papers');
  const prodPaper = new Map(paperRows.map((row) => [row.sourcePath, row.id]));
  const { rows: questionRows } = await client.query('SELECT id, "paperId", "rootNumber", parts FROM bank_questions');
  const prodQuestion = new Map(questionRows.map((row) => [`${row.paperId}:${row.rootNumber}`, row]));
  const resolve = (sourcePathValue, rootNumber) => {
    const paperId = prodPaper.get(sourcePathValue);
    return paperId === undefined ? undefined : prodQuestion.get(`${paperId}:${rootNumber}`);
  };

  if (trial) await client.query('BEGIN');

  // ---- json: bank_questions.parts ----------------------------------------
  if (only !== 'rows') {
    const local = src.prepare(`
      SELECT q.parts, p.source_path, q.root_number
      FROM bank_questions q JOIN bank_papers p ON p.id = q.paper_id
      WHERE q.parts <> '[]' AND q.parts <> ''
    `).all();
    const todo = [];
    for (const row of local) {
      const target = resolve(row.source_path, row.root_number);
      if (target && (target.parts === '[]' || target.parts === '' || target.parts == null)) todo.push([target.id, row.parts]);
    }
    log(`json: ${fmt(local.length)} local, ${fmt(todo.length)} production questions still at '[]'`);
    let filled = 0;
    if (apply || trial) {
      for (let i = 0, n = 0; i < todo.length && n < sample; i += BATCH, n += 1) {
        const slice = todo.slice(i, i + BATCH);
        const params = [];
        const tuples = slice.map((row, r) => { params.push(row[0], row[1]); return `($${r * 2 + 1}::int, $${r * 2 + 2}::text)`; });
        const { rows } = await client.query(
          `UPDATE bank_questions q SET parts = v.parts
           FROM (VALUES ${tuples.join(',')}) AS v(id, parts)
           WHERE q.id = v.id AND (q.parts = '[]' OR q.parts = '')
           RETURNING q.id`, params);
        filled += rows.length;
        for (const row of rows) record({ kind: 'parts-json', questionId: row.id });
        log(`json: ${fmt(Math.min(i + BATCH, todo.length))}/${fmt(todo.length)} (${fmt(filled)} filled)`);
      }
    }
  }

  // ---- rows: bank_question_parts -------------------------------------------
  if (only !== 'json') {
    const hasTable = src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bank_question_parts'").get();
    const local = hasTable ? src.prepare(`
      SELECT bp.label, bp.ordering, bp.marks, bp.topic, bp.difficulty, bp.rationale, bp.model, bp.prompt_version,
             p.source_path, q.root_number
      FROM bank_question_parts bp
      JOIN bank_questions q ON q.id = bp.question_id
      JOIN bank_papers p ON p.id = q.paper_id
    `).all() : [];
    const rows = [];
    for (const row of local) {
      const target = resolve(row.source_path, row.root_number);
      if (target) rows.push({ ...row, questionId: target.id });
    }
    log(`rows: ${fmt(local.length)} local part rows, ${fmt(rows.length)} resolve to production questions`);
    if (local.length === 0) log('rows: nothing tagged locally yet (run tag_parts first).');

    const exists = await client.query(`SELECT to_regclass('bank_question_parts') AS t`);
    if ((apply || trial) && rows.length > 0 && !exists.rows[0].t) {
      throw new Error('bank_question_parts does not exist in production: apply migration 20261016120000_bank_question_parts first (npx prisma migrate deploy).');
    }
    let inserted = 0;
    if ((apply || trial) && rows.length > 0) {
      for (let i = 0, n = 0; i < rows.length && n < sample; i += BATCH, n += 1) {
        const slice = rows.slice(i, i + BATCH);
        const params = [];
        const tuples = slice.map((row, r) => {
          params.push(row.questionId, row.label, row.ordering, row.marks ?? null, row.topic ?? null,
            row.difficulty ?? null, row.rationale ?? null, row.model ?? null, row.prompt_version ?? null);
          const b = r * 9;
          return `($${b + 1}::int,$${b + 2}::text,$${b + 3}::int,$${b + 4}::int,$${b + 5}::text,$${b + 6}::int,$${b + 7}::text,$${b + 8}::text,$${b + 9}::text)`;
        });
        const conflict = refresh
          ? `DO UPDATE SET ordering = EXCLUDED.ordering, marks = EXCLUDED.marks, topic = EXCLUDED.topic,
               difficulty = EXCLUDED.difficulty, rationale = EXCLUDED.rationale,
               model = EXCLUDED.model, "promptVersion" = EXCLUDED."promptVersion"`
          : 'DO NOTHING';
        const result = await client.query(
          `INSERT INTO bank_question_parts ("questionId", label, ordering, marks, topic, difficulty, rationale, model, "promptVersion")
           VALUES ${tuples.join(',')} ON CONFLICT ("questionId", label) ${conflict} RETURNING id, "questionId", label`, params);
        inserted += result.rows.length;
        for (const row of result.rows) record({ kind: 'part-row', id: row.id, questionId: row.questionId, label: row.label });
        log(`rows: ${fmt(Math.min(i + BATCH, rows.length))}/${fmt(rows.length)} (${fmt(inserted)} written)`);
      }
    }
  }

  if (!apply && !trial) {
    console.log('\nVerification only. Re-run with --trial to rehearse, or --apply to write.');
  } else if (trial) {
    await client.query('ROLLBACK');
    console.log('\nTrial only (first few batches): rolled back, nothing was written.');
  } else {
    console.log(`\nDone. Backup of everything written: ${backupPath}`);
  }
} catch (error) {
  if (trial) await client.query('ROLLBACK').catch(() => {});
  console.error(`\nFAILED: ${error.message}${apply ? ' -- committed batches stay; re-run --apply to continue.' : ''}`);
  process.exit(1);
} finally {
  src.close();
  await client.end().catch(() => {});
}
