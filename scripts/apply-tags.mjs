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
 * --apply appends to backups/tags-<timestamp>.jsonl after every batch: the tag
 * slugs, links and question ids it created or filled. To undo: delete those
 * links and tags, and set those reasons back to NULL. --apply commits per batch
 * (resumable); --trial runs only the first few batches, then rolls back.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
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
const client = new pg.Client({ ...pgConfig(url), connectionTimeoutMillis: 30_000, keepAlive: true });
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

const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

try {
  log('connecting (gives up after 30 s)...');
  await client.connect();
  console.log(`connected: ${url.replace(/\/\/[^@]*@/, '//***@')}`);
  console.log(`source:    ${sourcePath}\n`);

  const before = await counts();
  console.log(`BEFORE   tags: ${fmt(before.tags)}   links: ${fmt(before.links)}   reasons: ${fmt(before.reasons)}`);

  // Papers are matched on sourcePath, questions on (paperId, rootNumber): the
  // same keys merge_to_neon.py and apply-topics.mjs use.
  log('reading production paper and question ids...');
  const { rows: paperRows } = await client.query('SELECT id, "sourcePath" FROM bank_papers');
  const prodPaper = new Map(paperRows.map((row) => [row.sourcePath, row.id]));
  const { rows: questionRows } = await client.query('SELECT id, "paperId", "rootNumber" FROM bank_questions');
  const prodQuestion = new Map(questionRows.map((row) => [`${row.paperId}:${row.rootNumber}`, row.id]));
  const productionId = (sourcePathValue, rootNumber) => {
    const paperId = prodPaper.get(sourcePathValue);
    return paperId === undefined ? undefined : prodQuestion.get(`${paperId}:${rootNumber}`);
  };

  log('reading the local extraction store...');
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

  // --apply commits batch by batch, so a dropped connection loses at most one
  // batch and a re-run carries on (everything is ON CONFLICT / only-if-empty).
  // --trial does a small sample inside one transaction and rolls it back.
  const sample = trial ? 3 : Infinity;
  if (trial) await client.query('BEGIN');

  mkdirSync('backups', { recursive: true });
  const backupPath = join('backups', `tags-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const record = (entry) => { if (apply) appendFileSync(backupPath, JSON.stringify(entry) + '\n'); };

  // --- tags (batched: 38k one-row inserts was the slow part) ----------------
  const tagId = new Map();
  const tagsToSend = localTags.filter((tag) => usedTags.has(tag.id));
  let tagsInserted = 0;
  for (let i = 0, n = 0; i < tagsToSend.length && n < sample; i += LINK_BATCH, n += 1) {
    const slice = tagsToSend.slice(i, i + LINK_BATCH);
    const params = [];
    const tuples = slice.map((tag, r) => {
      params.push(tag.slug, tag.label);
      return `($${r * 2 + 1}::text, $${r * 2 + 2}::text)`;
    });
    const { rows } = await client.query(
      `INSERT INTO bank_tags (slug, label) VALUES ${tuples.join(',')}
       ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
       RETURNING id, slug, (xmax = 0) AS inserted`,
      params,
    );
    const bySlug = new Map(rows.map((row) => [row.slug, row]));
    for (const tag of slice) {
      const row = bySlug.get(tag.slug);
      tagId.set(tag.id, row.id);
      if (row.inserted) { tagsInserted += 1; record({ kind: 'tag', slug: tag.slug }); }
    }
    log(`tags: ${fmt(Math.min(i + LINK_BATCH, tagsToSend.length))}/${fmt(tagsToSend.length)} (${fmt(tagsInserted)} new)`);
  }

  // --- links ---------------------------------------------------------------
  let linksInserted = 0;
  const usable = links.filter((link) => tagId.has(link.localTag));
  for (let i = 0, n = 0; i < usable.length && n < sample; i += LINK_BATCH, n += 1) {
    const slice = usable.slice(i, i + LINK_BATCH);
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
    linksInserted += rows.length;
    for (const row of rows) record({ kind: 'link', questionId: row.questionId, tagId: row.tagId });
    log(`links: ${fmt(Math.min(i + LINK_BATCH, usable.length))}/${fmt(usable.length)} (${fmt(linksInserted)} new)`);
  }

  // --- reasons: only where there is none ------------------------------------
  let reasonsFilled = 0;
  for (let i = 0, n = 0; i < reasons.length && n < sample; i += REASON_BATCH, n += 1) {
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
    reasonsFilled += rows.length;
    for (const row of rows) record({ kind: 'reason', questionId: row.id });
    log(`reasons: ${fmt(Math.min(i + REASON_BATCH, reasons.length))}/${fmt(reasons.length)} (${fmt(reasonsFilled)} filled)`);
  }

  const after = await counts();
  console.log(`\nAFTER    tags: ${fmt(after.tags)}   links: ${fmt(after.links)}   reasons: ${fmt(after.reasons)}`);

  if (trial) {
    await client.query('ROLLBACK');
    console.log('\nTrial only (first few batches): rolled back, nothing was written.');
  } else {
    console.log(`\nDone. Backup of everything created: ${backupPath}`);
  }
} catch (error) {
  if (trial) await client.query('ROLLBACK').catch(() => {});
  console.error(`\nFAILED: ${error.message}${apply ? ' -- batches already committed stay; re-run --apply to continue.' : ''}`);
  process.exit(1);
} finally {
  src.close();
  await client.end().catch(() => {});
}
