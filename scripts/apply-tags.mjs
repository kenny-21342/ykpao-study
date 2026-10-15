/**
 * Push the skill tags and the one-line difficulty reasons from the local
 * extraction store to production.
 *
 * WHY THIS EXISTS. The tagging pass (28 Sep) produced, besides topics and a
 * difficulty number, two things that never reached production: 38,702 tags with
 * 272,692 question links ("projectile motion", "boolean expression"), and a
 * sentence per question saying what sets its level ("requires combining arc
 * length and sector area with trigonometric lengths derived from the diagram").
 * `apply-topics.mjs` and `apply-transcriptions.mjs` carried only topics and the
 * difficulty number. The Practice "Peek" reads both, and showed neither: sampled
 * on 15 Oct across four subjects, 0 of 388 questions had a tag or a reason.
 *
 * Nothing here costs a model call; it is all already computed.
 *
 *   node scripts/apply-tags.mjs              # verify only, writes nothing
 *   node scripts/apply-tags.mjs --trial      # write inside a transaction, report, roll back
 *   node scripts/apply-tags.mjs --apply      # write for real
 *   node scripts/apply-tags.mjs --source other.db
 *
 * Reads DIRECT_DATABASE_URL, falling back to DATABASE_URL. Use the direct
 * (non `-pooler`) endpoint.
 *
 * ADDITIVE AND IDEMPOTENT.
 *   - Tags are matched on slug and links are ON CONFLICT DO NOTHING.
 *   - A reason is written only where `difficultyRationale` is NULL or empty, so
 *     nothing already there is overwritten and a re-run finds nothing to do.
 *   - Only questions that exist in production are touched. Links to the
 *     crop-failed questions that were deliberately never merged are skipped.
 *
 * --apply writes backups/tags-<timestamp>.jsonl first: the tag slugs it
 * creates, every link it creates, and the question ids whose reason it fills.
 * To undo: delete those links and tags, and set those reasons back to NULL.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';

import { pgConfig } from '../lib/db-ssl.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const trial = args.includes('--trial');
const sourceIdx = args.indexOf('--source');
const sourcePath = sourceIdx >= 0 && args[sourceIdx + 1] ? args[sourceIdx + 1] : 'pdf_extraction/bank/extract.db';

const LINK_BATCH = 2000;
const REASON_BATCH = 500;

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
const client = new pg.Client(pgConfig(url));
client.on('error', (error) => console.error(`\n(connection error: ${error.message})`));

const counts = async () => {
  const { rows } = await client.query(`
    SELECT (SELECT count(*) FROM bank_tags)          AS tags,
           (SELECT count(*) FROM bank_question_tags) AS links,
           (SELECT count(*) FROM bank_questions
             WHERE status = 'published' AND coalesce("difficultyRationale", '') <> '') AS reasons
  `);
  return rows[0];
};
const fmt = (value) => Number(value).toLocaleString();

try {
  await client.connect();
  console.log(`connected: ${url.replace(/\/\/[^@]*@/, '//***@')}`);
  console.log(`source:    ${sourcePath}\n`);

  const before = await counts();
  console.log(`BEFORE   tags: ${fmt(before.tags)}   links: ${fmt(before.links)}   reasons: ${fmt(before.reasons)}`);

  // Papers are matched on sourcePath, questions on (paperId, rootNumber): the
  // same keys merge_to_neon.py and apply-topics.mjs use.
  const { rows: paperRows } = await client.query('SELECT id, "sourcePath" FROM bank_papers');
  const prodPaper = new Map(paperRows.map((row) => [row.sourcePath, row.id]));
  const { rows: questionRows } = await client.query('SELECT id, "paperId", "rootNumber" FROM bank_questions');
  const prodQuestion = new Map(questionRows.map((row) => [`${row.paperId}:${row.rootNumber}`, row.id]));
  const productionId = (sourcePathValue, rootNumber) => {
    const paperId = prodPaper.get(sourcePathValue);
    return paperId === undefined ? undefined : prodQuestion.get(`${paperId}:${rootNumber}`);
  };

  const localTags = src.prepare('SELECT id, slug, label FROM bank_tags').all();
  const localLinks = src.prepare(`
    SELECT qt.tag_id, qt.confidence, p.source_path, q.root_number
    FROM bank_question_tags qt
    JOIN bank_questions q ON q.id = qt.question_id
    JOIN bank_papers p ON p.id = q.paper_id
  `).all();
  const localReasons = src.prepare(`
    SELECT q.difficulty_rationale AS reason, p.source_path, q.root_number
    FROM bank_questions q JOIN bank_papers p ON p.id = q.paper_id
    WHERE coalesce(q.difficulty_rationale, '') <> ''
  `).all();
  console.log(`local    tags: ${fmt(localTags.length)}   links: ${fmt(localLinks.length)}   reasons: ${fmt(localReasons.length)}`);

  const links = [];
  const usedTags = new Set();
  for (const link of localLinks) {
    const questionId = productionId(link.source_path, link.root_number);
    if (questionId === undefined) continue;
    links.push({ questionId, localTag: link.tag_id, confidence: link.confidence ?? 0 });
    usedTags.add(link.tag_id);
  }
  const reasons = [];
  for (const row of localReasons) {
    const questionId = productionId(row.source_path, row.root_number);
    if (questionId !== undefined) reasons.push([questionId, String(row.reason).trim().slice(0, 500)]);
  }
  console.log(`resolve  links: ${fmt(links.length)} (${fmt(localLinks.length - links.length)} point at questions not in production)`);
  console.log(`         tags in use: ${fmt(usedTags.size)}   reasons: ${fmt(reasons.length)}`);

  if (!apply && !trial) {
    console.log('\nVerification only. Re-run with --trial to rehearse, or --apply to write.');
    process.exit(0);
  }

  await client.query('BEGIN');
  const backup = { tags: [], links: [], reasons: [] };

  // --- tags ----------------------------------------------------------------
  const tagId = new Map();
  for (const tag of localTags) {
    if (!usedTags.has(tag.id)) continue;
    const { rows } = await client.query(
      `INSERT INTO bank_tags (slug, label) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
       RETURNING id, (xmax = 0) AS inserted`,
      [tag.slug, tag.label],
    );
    tagId.set(tag.id, rows[0].id);
    if (rows[0].inserted) backup.tags.push(tag.slug);
  }
  console.log(`\ntags: ${fmt(backup.tags.length)} inserted, ${fmt(tagId.size - backup.tags.length)} already present`);

  // --- links ---------------------------------------------------------------
  for (let i = 0; i < links.length; i += LINK_BATCH) {
    const slice = links.slice(i, i + LINK_BATCH);
    const params = [];
    const tuples = slice.map((link, r) => {
      params.push(link.questionId, tagId.get(link.localTag), link.confidence);
      return `($${r * 3 + 1}::int, $${r * 3 + 2}::int, $${r * 3 + 3}::float)`;
    });
    const { rows } = await client.query(
      `INSERT INTO bank_question_tags ("questionId", "tagId", confidence)
       VALUES ${tuples.join(',')}
       ON CONFLICT DO NOTHING
       RETURNING "questionId", "tagId"`,
      params,
    );
    for (const row of rows) backup.links.push([row.questionId, row.tagId]);
    process.stdout.write(`\r  links: ${fmt(Math.min(i + LINK_BATCH, links.length))}/${fmt(links.length)} -- ${fmt(backup.links.length)} inserted`);
  }
  if (links.length) process.stdout.write('\n');

  // --- reasons: only where there is none ------------------------------------
  for (let i = 0; i < reasons.length; i += REASON_BATCH) {
    const slice = reasons.slice(i, i + REASON_BATCH);
    const params = [];
    const tuples = slice.map((row, r) => {
      params.push(row[0], row[1]);
      return `($${r * 2 + 1}::int, $${r * 2 + 2}::text)`;
    });
    const { rows } = await client.query(
      `UPDATE bank_questions q SET "difficultyRationale" = v.reason
       FROM (VALUES ${tuples.join(',')}) AS v(id, reason)
       WHERE q.id = v.id AND coalesce(q."difficultyRationale", '') = ''
       RETURNING q.id`,
      params,
    );
    for (const row of rows) backup.reasons.push(row.id);
    process.stdout.write(`\r  reasons: ${fmt(Math.min(i + REASON_BATCH, reasons.length))}/${fmt(reasons.length)} -- ${fmt(backup.reasons.length)} filled`);
  }
  if (reasons.length) process.stdout.write('\n');

  const after = await counts();
  console.log(`\nAFTER    tags: ${fmt(after.tags)}   links: ${fmt(after.links)}   reasons: ${fmt(after.reasons)}`);

  if (apply) {
    // Backup first, then commit: if the file cannot be written nothing has landed.
    mkdirSync('backups', { recursive: true });
    const backupPath = join('backups', `tags-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    writeFileSync(backupPath, [
      JSON.stringify({ kind: 'tags', slugs: backup.tags }),
      JSON.stringify({ kind: 'reasons', questionIds: backup.reasons }),
      ...backup.links.map((pair) => JSON.stringify({ kind: 'link', questionId: pair[0], tagId: pair[1] })),
    ].join('\n') + '\n');
    await client.query('COMMIT');
    console.log(`\nCommitted. Backup of everything created: ${backupPath}`);
  } else {
    await client.query('ROLLBACK');
    console.log('\nTrial only: rolled back, nothing was written.');
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`\nFAILED (rolled back): ${error.message}`);
  process.exit(1);
} finally {
  src.close();
  await client.end().catch(() => {});
}
