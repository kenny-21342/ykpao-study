/**
 * Push multiple-choice answer keys from the local extraction store to production.
 *
 * Production holds **zero** answer keys for 9,408 published IB Paper 1
 * questions, every one of which is a multiple-choice question whose answer was
 * sitting in a mark scheme already on disk. The cause was one character:
 * `spans._detect_answer_key` required a bare question number and the IB writes
 * "1." with a period, so the detector recognised no IB key at all.
 *
 * What that costs a student is not subtle. `lib/paper-format-overlay.ts`
 * decides a paper is multiple choice from the share of its questions carrying
 * a key, so an IB Paper 1 measured as `structured`; and `decideGradingMode`
 * sends an unkeyed question to a model. A generated IB Physics Paper 1 was
 * forty multiple-choice questions sent one at a time to a vision model, to be
 * marked against no mark scheme -- slow, paid for, and wrong. With the keys
 * landed, the same paper marks itself in the request for nothing.
 *
 *   node scripts/apply-answer-keys.mjs              # verify only, writes nothing
 *   node scripts/apply-answer-keys.mjs --apply      # verify, then write
 *   node scripts/apply-answer-keys.mjs --board IB
 *
 * Run `python3 -m pdf_extraction.bank.answer_keys --apply` first: that fills
 * the local store from the mark schemes the old detector skipped.
 *
 * Reads DIRECT_DATABASE_URL, falling back to DATABASE_URL. Use the direct
 * (non `-pooler`) endpoint.
 *
 * WHY TWO STATEMENTS. `bank_mark_schemes` carries two unique constraints in
 * production -- `questionId`, and `(paperId, rootNumber)` -- and a single
 * `ON CONFLICT` can name only one of them, so an insert colliding on the other
 * aborts the batch. An UPDATE for rows that exist and a guarded INSERT for
 * rows that do not is explicit about both.
 *
 * Idempotent, and additive only. The UPDATE fills `answerLetter` solely where
 * it is NULL, so a key a human has corrected is never overwritten, and the
 * INSERT skips any question that already has a mark scheme. A re-run writes
 * nothing.
 */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import pg from 'pg';

import { pgConfig } from '../lib/db-ssl.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const sourcePath = flag('--source', 'pdf_extraction/bank/extract.db');
const board = flag('--board', null);

const BATCH = 500;

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
// Aiven issues a per-project CA that Node does not trust out of the box, and
// `pg` lets an `sslmode` in the URL replace an explicit `ssl` option rather
// than merge with it, so the certificate goes through the one helper that
// knows both facts.
const client = new pg.Client(pgConfig(url));

const show = (rows) => {
  if (!rows.length) return console.log('  (no rows)');
  const cols = Object.keys(rows[0]);
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  console.log('  ' + cols.map((c, i) => c.padEnd(w[i])).join('  '));
  console.log('  ' + w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) {
    console.log('  ' + cols.map((c, i) => String(r[c] ?? '').padEnd(w[i])).join('  '));
  }
};

const counts = async () => (await client.query(`
  SELECT
    (SELECT count(*) FROM bank_mark_schemes)                              AS ms_rows,
    (SELECT count(*) FROM bank_mark_schemes WHERE "answerLetter" IS NOT NULL) AS with_key,
    (SELECT count(*) FROM bank_mark_schemes m JOIN bank_papers p ON p.id = m."paperId"
      WHERE p.board = 'IB' AND m."answerLetter" IS NOT NULL)              AS ib_with_key
`)).rows;

async function runBatch(sql, rows, arity) {
  if (rows.length === 0) return 0;
  const params = [];
  const tuples = rows.map((row, r) => {
    const slots = row.map((_, c) => `$${r * arity + c + 1}`);
    params.push(...row);
    return `(${slots.join(',')})`;
  });
  const result = await client.query(sql.replace('__VALUES__', tuples.join(',')), params);
  return result.rowCount ?? 0;
}

try {
  await client.connect();
  console.log(`connected: ${url.replace(/\/\/[^@]*@/, '//***@')}`);
  console.log(`source:    ${sourcePath}${board ? `  (board ${board})` : ''}\n`);
  console.log('BEFORE');
  show(await counts());

  // Papers match on sourcePath, the same key merge_to_neon.py uses and unique
  // on both sides.
  const { rows: paperRows } = await client.query('SELECT id, "sourcePath" FROM bank_papers');
  const prodPaperId = new Map(paperRows.map((r) => [r.sourcePath, r.id]));

  /*
   * Two papers per key, and they are different rows.
   *
   * The mark scheme belongs to the `ms` document; the question it answers
   * belongs to the `qp` document. Production's `bank_mark_schemes.paperId`
   * points at the `ms` paper (all 52,925 existing rows do), while the question
   * is found through the `qp` paper -- so both have to be resolved, and
   * confusing them is what made an earlier pusher report success having
   * written nothing.
   */
  const local = src.prepare(`
    SELECT msp.source_path AS ms_path,
           qpp.source_path AS qp_path,
           q.root_number,
           m.answer_letter
      FROM bank_mark_schemes m
      JOIN bank_papers   msp ON msp.id = m.paper_id
      JOIN bank_questions q  ON q.id  = m.question_id
      JOIN bank_papers   qpp ON qpp.id = q.paper_id
     WHERE m.answer_letter IS NOT NULL
       AND trim(m.answer_letter) <> ''
       ${board ? 'AND msp.board = @board' : ''}
  `).all(board ? { board } : {});

  let orphaned = 0;
  const resolved = [];
  for (const row of local) {
    const msId = prodPaperId.get(row.ms_path);
    const qpId = prodPaperId.get(row.qp_path);
    if (msId === undefined || qpId === undefined) { orphaned += 1; continue; }
    resolved.push([msId, qpId, row.root_number, row.answer_letter]);
  }

  console.log(`\nlocal keys linked to a question: ${local.length.toLocaleString()}`);
  console.log(`  resolvable in production:      ${resolved.length.toLocaleString()}`);
  if (orphaned > 0) {
    console.log(`  ! ${orphaned.toLocaleString()} sit on papers not in production (run merge_to_neon.py first)`);
  }

  if (!apply) {
    console.log('\nVerification only. Re-run with --apply to write.');
    process.exit(0);
  }

  // Existing rows: fill the key only where there is none.
  const UPDATE_SQL = `
    UPDATE bank_mark_schemes AS t
       SET "answerLetter" = v.answer_letter,
           "totalMarks"   = COALESCE(t."totalMarks", 1)
      FROM (VALUES __VALUES__) AS v(ms_paper_id, qp_paper_id, root_number, answer_letter)
      JOIN bank_questions q
        ON q."paperId" = v.qp_paper_id::int AND q."rootNumber" = v.root_number::int
     WHERE t."questionId" = q.id
       AND t."answerLetter" IS NULL
  `;

  // Missing rows: a mark scheme whose whole content is the letter. Guarded on
  // both unique constraints rather than left to ON CONFLICT, which can name
  // only one of them.
  const INSERT_SQL = `
    INSERT INTO bank_mark_schemes
      ("questionId", "paperId", "rootNumber", "answerMd", "markingPoints",
       "totalMarks", "answerLetter", confidence, status, "runId", model, "promptVersion")
    SELECT q.id, v.ms_paper_id::int, v.root_number::int, v.answer_letter, '[]',
           1, v.answer_letter, 1.0, 'published', 'answer-key-backfill',
           'deterministic', 'answer-key-v2'
      FROM (VALUES __VALUES__) AS v(ms_paper_id, qp_paper_id, root_number, answer_letter)
      JOIN bank_questions q
        ON q."paperId" = v.qp_paper_id::int AND q."rootNumber" = v.root_number::int
     WHERE NOT EXISTS (SELECT 1 FROM bank_mark_schemes e WHERE e."questionId" = q.id)
       AND NOT EXISTS (SELECT 1 FROM bank_mark_schemes e
                        WHERE e."paperId" = v.ms_paper_id::int
                          AND e."rootNumber" = v.root_number::int)
  `;

  let updated = 0;
  for (let i = 0; i < resolved.length; i += BATCH) {
    updated += await runBatch(UPDATE_SQL, resolved.slice(i, i + BATCH), 4);
    process.stdout.write(`\r  updating: ${Math.min(i + BATCH, resolved.length).toLocaleString()}/${resolved.length.toLocaleString()} — ${updated.toLocaleString()} filled`);
  }
  if (resolved.length) process.stdout.write('\n');

  let inserted = 0;
  for (let i = 0; i < resolved.length; i += BATCH) {
    inserted += await runBatch(INSERT_SQL, resolved.slice(i, i + BATCH), 4);
    process.stdout.write(`\r  inserting: ${Math.min(i + BATCH, resolved.length).toLocaleString()}/${resolved.length.toLocaleString()} — ${inserted.toLocaleString()} created`);
  }
  if (resolved.length) process.stdout.write('\n');

  console.log(`\nkeys filled on existing rows: ${updated.toLocaleString()}`);
  console.log(`mark schemes created:         ${inserted.toLocaleString()}`);
  console.log('\nAFTER');
  show(await counts());
} finally {
  await client.end().catch(() => {});
  src.close();
}
