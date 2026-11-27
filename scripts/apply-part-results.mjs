/**
 * Push `tag_parts --from-json` results to production, then give every
 * multi-part question the union of its parts' topics.
 *
 *   node --env-file=.env scripts/apply-part-results.mjs RESULTS.jsonl            # verify, write nothing
 *   node --env-file=.env scripts/apply-part-results.mjs RESULTS.jsonl --trial    # write, then roll back
 *   node --env-file=.env scripts/apply-part-results.mjs RESULTS.jsonl --apply
 *   node --env-file=.env scripts/apply-part-results.mjs - --apply --only union    # union step alone
 *
 * rows   Insert per-part rows keyed by production question id. Additive:
 *        ON CONFLICT DO NOTHING, so parts already present are never touched.
 * union  For each published question, link every topic a part names that the
 *        question lacks. Links mirror how question topics are already stored:
 *        to the topic row of that name under every subject row sharing the
 *        question's board and code (its own level and the combined HLSL row).
 *        A topic missing from the question's own subject (a topic new to the
 *        syllabus registry) is created there first. Purely additive.
 *
 * Everything --apply creates is appended to backups/part-results-<ts>.jsonl,
 * which is all a rollback needs (delete those rows).
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

import { pgConfig } from '../lib/db-ssl.ts';

const args = process.argv.slice(2);
const source = args[0];
const apply = args.includes('--apply');
const trial = args.includes('--trial');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : 'both';
if (!source) { console.error('usage: apply-part-results.mjs RESULTS.jsonl|- [--trial|--apply] [--only rows|union]'); process.exit(1); }
const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
const backupPath = join('backups', `part-results-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const record = (entry) => { if (apply) appendFileSync(backupPath, JSON.stringify(entry) + '\n'); };
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const BATCH = 500;
const clean = (v) => (typeof v === 'string' ? v.replaceAll('\0', '') : v);

const client = new pg.Client({ ...pgConfig(url), connectionTimeoutMillis: 30_000, keepAlive: true });
try {
  await client.connect();
  if (apply) mkdirSync('backups', { recursive: true });
  if (trial || apply) await client.query('BEGIN');

  if (only !== 'union' && source !== '-') {
    const results = readFileSync(source, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const rows = results.flatMap((r) => r.parts.map((p) => ({ ...p, questionId: r.questionId, model: r.model, promptVersion: r.promptVersion })));
    log(`rows: ${results.length} questions, ${rows.length} part rows in ${source}`);
    let inserted = 0;
    if (trial || apply) {
      for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH);
        const params = [];
        const tuples = slice.map((row, r) => {
          params.push(row.questionId, clean(row.label), row.ordering, row.marks ?? null, clean(row.topic) ?? null,
            row.difficulty ?? null, clean(row.rationale) ?? null, row.model ?? null, row.promptVersion ?? null);
          const b = r * 9;
          return `($${b + 1}::int,$${b + 2}::text,$${b + 3}::int,$${b + 4}::int,$${b + 5}::text,$${b + 6}::int,$${b + 7}::text,$${b + 8}::text,$${b + 9}::text)`;
        });
        // Only into questions that still exist and are published.
        const result = await client.query(
          `INSERT INTO bank_question_parts ("questionId", label, ordering, marks, topic, difficulty, rationale, model, "promptVersion")
           SELECT v.* FROM (VALUES ${tuples.join(',')}) AS v(q, label, ordering, marks, topic, difficulty, rationale, model, pv)
           JOIN bank_questions bq ON bq.id = v.q AND bq.status = 'published'
           ON CONFLICT ("questionId", label) DO NOTHING RETURNING id, "questionId", label`, params);
        inserted += result.rows.length;
        for (const row of result.rows) record({ kind: 'part-row', id: row.id, questionId: row.questionId, label: row.label });
      }
      log(`rows: ${inserted} written`);
    }
  }

  if (only !== 'rows') {
    const missing = `
      SELECT DISTINCT pp."questionId" AS qid, pp.topic, s.id AS sid, s.board, s.code
      FROM bank_question_parts pp
      JOIN bank_questions bq ON bq.id = pp."questionId" AND bq.status = 'published'
      JOIN bank_papers p ON p.id = bq."paperId"
      JOIN bank_subjects s ON s.id = p."subjectId"
      WHERE pp.topic IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM bank_question_topics t JOIN bank_topics bt ON bt.id = t."topicId"
                        WHERE t."questionId" = pp."questionId" AND bt.name = pp.topic)`;
    const { rows: before } = await client.query(`SELECT count(DISTINCT qid) AS q, count(*) AS n FROM (${missing}) m`);
    log(`union: ${before[0].q} questions lack ${before[0].n} topics their parts name`);
    if (trial || apply) {
      const created = await client.query(`
        INSERT INTO bank_topics ("subjectId", name)
        SELECT DISTINCT sid, topic FROM (${missing}) m
        ON CONFLICT ("subjectId", name) DO NOTHING RETURNING id, "subjectId", name`);
      for (const row of created.rows) record({ kind: 'topic', ...row });
      log(`union: ${created.rows.length} topic rows created (${created.rows.map((r) => r.name).filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'none'})`);
      const linked = await client.query(`
        INSERT INTO bank_question_topics ("questionId", "topicId", confidence)
        SELECT DISTINCT m.qid, bt.id, 0
        FROM (${missing}) m
        JOIN bank_subjects ts ON ts.board = m.board AND ts.code = m.code
        JOIN bank_topics bt ON bt."subjectId" = ts.id AND bt.name = m.topic
        ON CONFLICT DO NOTHING RETURNING "questionId", "topicId"`);
      for (const row of linked.rows) record({ kind: 'question-topic', ...row });
      const { rows: after } = await client.query(`SELECT count(*) AS n FROM (${missing}) m`);
      log(`union: ${linked.rows.length} links written; ${after[0].n} still missing`);
    }
  }

  if (trial) { await client.query('ROLLBACK'); console.log('\nTrial: rolled back, nothing written.'); }
  else if (apply) { await client.query('COMMIT'); console.log(`\nDone. Backup: ${backupPath}`); }
  else console.log('\nVerification only. --trial to rehearse, --apply to write.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`\nFAILED (rolled back): ${error.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
