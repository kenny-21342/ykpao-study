/**
 * Replace the topic links of one subject's questions in production with the ones
 * in the local extraction store.
 *
 * WHY THIS EXISTS. `apply-topics.mjs` only ever adds links (ON CONFLICT DO
 * NOTHING). Re-tagging a subject against the right syllabus -- IB Physics from
 * 2025 has themes A-E instead of the 2016 topics, and Standard level has no
 * Higher-level-only topics -- must also remove the links that were wrong, or
 * every 2025 question would carry both its old topic and its new one.
 *
 *   node scripts/apply-retopic.mjs --subject physics              # verify only
 *   node scripts/apply-retopic.mjs --subject physics --trial      # first batches, rolled back
 *   node scripts/apply-retopic.mjs --subject physics --apply      # write for real
 *   node scripts/apply-retopic.mjs --subject physics --year 2025  # narrow to one exam year
 *
 * Reads DIRECT_DATABASE_URL, falling back to DATABASE_URL (use the non-pooler one).
 *
 * Only questions that have at least one local topic link are touched: a question
 * the local store has no opinion on keeps what production has. Each batch is one
 * transaction (a dropped connection loses at most one batch; a re-run carries on
 * and finds nothing left to change). --apply appends every deleted link to
 * backups/retopic-<timestamp>.jsonl BEFORE deleting it; to undo, re-insert them.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';

import { pgConfig } from '../lib/db-ssl.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const trial = args.includes('--trial');
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
};
const subjectCode = valueOf('--subject');
const year = valueOf('--year') ? Number(valueOf('--year')) : null;
const sourcePath = valueOf('--source') ?? 'pdf_extraction/bank/extract.db';
const BATCH = 200;

if (!subjectCode) {
  console.error('Name the subject: --subject physics');
  process.exit(1);
}
const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('Set DIRECT_DATABASE_URL (or DATABASE_URL) first.');
  process.exit(1);
}
if (url.includes('-pooler')) {
  console.error('That is the pooled endpoint. Use the direct one (drop "-pooler" from the host).');
  process.exit(1);
}
if (!existsSync(sourcePath)) {
  console.error(`Source SQLite not found: ${sourcePath}`);
  process.exit(1);
}

const src = new Database(sourcePath, { readonly: true });
const client = new pg.Client({ ...pgConfig(url), connectionTimeoutMillis: 30_000, keepAlive: true });
client.on('error', (error) => console.error(`\n(connection error: ${error.message})`));
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const fmt = (value) => Number(value).toLocaleString();

try {
  log('connecting...');
  await client.connect();
  console.log(`connected: ${url.replace(/\/\/[^@]*@/, '//***@')}`);

  const { rows: paperRows } = await client.query('SELECT id, "sourcePath" FROM bank_papers');
  const prodPaper = new Map(paperRows.map((row) => [row.sourcePath, row.id]));
  const { rows: questionRows } = await client.query('SELECT id, "paperId", "rootNumber" FROM bank_questions');
  const prodQuestion = new Map(questionRows.map((row) => [`${row.paperId}:${row.rootNumber}`, row.id]));
  const { rows: subjectRows } = await client.query('SELECT id, code FROM bank_subjects WHERE lower(code) = lower($1)', [subjectCode]);
  if (subjectRows.length === 0) throw new Error(`production has no subject with code "${subjectCode}"`);
  const subjectId = new Map(subjectRows.map((row) => [row.code.toLowerCase(), row.id])).get(subjectCode.toLowerCase());

  // Local: for every question of the subject, its topic names.
  const local = src.prepare(`
    SELECT p.source_path, q.root_number, t.name, qt.confidence
    FROM bank_question_topics qt
    JOIN bank_topics t ON t.id = qt.topic_id
    JOIN bank_questions q ON q.id = qt.question_id
    JOIN bank_papers p ON p.id = q.paper_id
    JOIN bank_subjects s ON s.id = p.subject_id
    WHERE lower(s.code) = lower(?) ${year ? 'AND p.year = ?' : ''}
  `).all(...(year ? [subjectCode, year] : [subjectCode]));

  const wanted = new Map(); // production question id -> Map(topic name -> confidence)
  let unresolved = 0;
  for (const row of local) {
    const paperId = prodPaper.get(row.source_path);
    const questionId = paperId === undefined ? undefined : prodQuestion.get(`${paperId}:${row.root_number}`);
    if (questionId === undefined) { unresolved += 1; continue; }
    if (!wanted.has(questionId)) wanted.set(questionId, new Map());
    wanted.get(questionId).set(row.name, row.confidence ?? null);
  }
  console.log(`local: ${fmt(local.length)} links over ${fmt(wanted.size)} questions (${fmt(unresolved)} not in production)`);

  const ids = [...wanted.keys()];
  const { rows: existing } = await client.query(
    `SELECT qt."questionId", qt."topicId", t.name FROM bank_question_topics qt
     JOIN bank_topics t ON t.id = qt."topicId" WHERE qt."questionId" = ANY($1::int[])`,
    [ids],
  );
  const have = new Map();
  for (const row of existing) {
    if (!have.has(row.questionId)) have.set(row.questionId, []);
    have.get(row.questionId).push(row);
  }
  let toDelete = 0;
  let toAdd = 0;
  let changed = 0;
  const changedIds = [];
  for (const [questionId, names] of wanted) {
    const current = have.get(questionId) ?? [];
    const stale = current.filter((row) => !names.has(row.name)).length;
    const missing = [...names.keys()].filter((name) => !current.some((row) => row.name === name)).length;
    toDelete += stale;
    toAdd += missing;
    if (stale || missing) { changed += 1; changedIds.push(questionId); }
  }
  console.log(`production: ${fmt(existing.length)} links now; would delete ${fmt(toDelete)}, add ${fmt(toAdd)}, over ${fmt(changed)} questions`);

  if (!apply && !trial) {
    console.log('\nVerification only. Re-run with --trial to rehearse, or --apply to write.');
    process.exit(0);
  }

  mkdirSync('backups', { recursive: true });
  const backupPath = join('backups', `retopic-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  // name -> production topic id. Topics of one IB subject are filed under
  // several level rows, so look a name up across all of them before creating.
  const topicId = new Map();
  const { rows: knownTopics } = await client.query(
    `SELECT t.id, t.name FROM bank_topics t JOIN bank_subjects s ON s.id = t."subjectId" WHERE lower(s.code) = lower($1) ORDER BY t.id`,
    [subjectCode],
  );
  for (const row of knownTopics) if (!topicId.has(row.name)) topicId.set(row.name, row.id);
  const ensureTopic = async (name) => {
    if (topicId.has(name)) return topicId.get(name);
    const { rows } = await client.query(
      `INSERT INTO bank_topics ("subjectId", code, name) VALUES ($1, $2, $3)
       ON CONFLICT ("subjectId", name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [subjectId, name.split(' ')[0].slice(0, 20), name],
    );
    topicId.set(name, rows[0].id);
    return rows[0].id;
  };

  let deleted = 0;
  let added = 0;
  const sampleBatches = trial ? 3 : Infinity;
  // Only the questions that actually change, so a trial exercises real edits.
  for (let i = 0, n = 0; i < changedIds.length && n < sampleBatches; i += BATCH, n += 1) {
    const slice = changedIds.slice(i, i + BATCH);
    await client.query('BEGIN');
    try {
      for (const questionId of slice) {
        const names = wanted.get(questionId);
        const current = have.get(questionId) ?? [];
        for (const row of current.filter((r) => !names.has(r.name))) {
          if (apply) appendFileSync(backupPath, JSON.stringify({ kind: 'link', questionId, topicId: row.topicId, name: row.name }) + '\n');
          await client.query('DELETE FROM bank_question_topics WHERE "questionId" = $1 AND "topicId" = $2', [questionId, row.topicId]);
          deleted += 1;
        }
        for (const [name, confidence] of names) {
          if (current.some((r) => r.name === name)) continue;
          const id = await ensureTopic(name);
          await client.query(
            'INSERT INTO bank_question_topics ("questionId", "topicId", confidence) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [questionId, id, confidence],
          );
          added += 1;
        }
      }
      await client.query(trial ? 'ROLLBACK' : 'COMMIT');
      // A rolled-back batch may have created topics; forget them.
      if (trial) { topicId.clear(); for (const row of knownTopics) if (!topicId.has(row.name)) topicId.set(row.name, row.id); }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
    log(`questions ${fmt(Math.min(i + BATCH, changedIds.length))}/${fmt(changedIds.length)}: ${fmt(deleted)} deleted, ${fmt(added)} added`);
  }
  console.log(trial ? '\nTrial only (first batches): rolled back, nothing was written.' : `\nDone. Deleted links are in ${backupPath}`);
} catch (error) {
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
} finally {
  src.close();
  await client.end().catch(() => {});
}
