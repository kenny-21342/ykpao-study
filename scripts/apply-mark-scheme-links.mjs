/**
 * Push mark schemes that are linked locally but never reached production.
 *
 * `pdf_extraction/bank/merge_to_neon.py` skips any mark scheme whose
 * `question_id` is NULL, and for a long time that was almost all of them:
 * `store.link_mark_schemes_to_questions` did the linking in one correlated
 * UPDATE, a UNIQUE collision on `question_id` aborted the whole statement, and
 * nothing was linked. `relink_mark_schemes.py` fixed that locally, row by row
 * -- but the merge had already run, and it is insert-only, so the newly linked
 * rows have been sitting in `extract.db` ever since.
 *
 * The visible effect is the one to fix: IB mark-scheme coverage reads 59.7% in
 * production against 81.6% in the local store, so a student who finishes an IB
 * question often cannot find its mark scheme even though the platform has it.
 *
 *   node scripts/apply-mark-scheme-links.mjs             # verify only, writes nothing
 *   node scripts/apply-mark-scheme-links.mjs --trial     # insert, report coverage, roll back
 *   node scripts/apply-mark-scheme-links.mjs --apply     # verify, back up, then insert
 *   node scripts/apply-mark-scheme-links.mjs --source other.db
 *
 * INSERT-ONLY AND IDEMPOTENT. Production's `bank_mark_schemes.questionId` is
 * NOT NULL and every row is already linked, so there is nothing to update: the
 * missing rows simply do not exist there. Every insert is guarded by
 * `WHERE NOT EXISTS (... questionId ...)`, so a question that already has a
 * mark scheme is left exactly as it is and a re-run writes nothing. No row is
 * ever updated or deleted.
 *
 * Before writing, `--apply` records every id it is about to create in a JSONL
 * file under `backups/` and prints the path. Nothing here overwrites existing
 * data, but that file is what makes the run reversible: deleting exactly those
 * ids restores the previous state.
 *
 * Reads DIRECT_DATABASE_URL, falling back to DATABASE_URL. Use the direct
 * (non `-pooler`) endpoint -- this holds one session across thousands of
 * inserts, and PgBouncer drops it partway through.
 *
 * Mark-scheme STRIPS are deliberately not merged. Of the rows this inserts,
 * all but one carry `answerMd` or `answerLetter`, so the text is the whole
 * value; strips would additionally need their assets uploaded, which is a
 * different job with a different risk profile.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';

import { pgConfig } from '../lib/db-ssl.ts';

const args = process.argv.slice(2);
const trial = args.includes('--trial');
// --trial runs the real inserts inside a transaction and rolls them back, so
// the resulting coverage can be read off production without changing it.
const apply = args.includes('--apply') || trial;
const sourceIdx = args.indexOf('--source');
const sourcePath = sourceIdx >= 0 && args[sourceIdx + 1] ? args[sourceIdx + 1] : 'pdf_extraction/bank/extract.db';

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
const client = new pg.Client(pgConfig(url));

const coverage = async () => {
  const { rows } = await client.query(`
    SELECT p.board,
           count(*)::int AS questions,
           count(ms.id)::int AS with_ms
    FROM bank_questions bq
    JOIN bank_papers p ON p.id = bq."paperId"
    LEFT JOIN bank_mark_schemes ms ON ms."questionId" = bq.id
    WHERE bq.status = 'published'
    GROUP BY p.board ORDER BY p.board
  `);
  return rows;
};

const report = (rows, label) => {
  console.log(`${label}:`);
  for (const r of rows) {
    const pct = ((100 * r.with_ms) / r.questions).toFixed(1);
    console.log(`  ${r.board.padEnd(5)} ${String(r.with_ms).padStart(6)} / ${String(r.questions).padStart(6)}  ${pct}%`);
  }
};

try {
  await client.connect();
  console.log(`connected: ${url.replace(/\/\/[^@]*@/, '//***@')}`);
  console.log(`source:    ${sourcePath}\n`);

  report(await coverage(), 'BEFORE');

  // Papers are matched on sourcePath and questions on (paperId, rootNumber) --
  // the same keys merge_to_neon.py and apply-topics.mjs use.
  const { rows: paperRows } = await client.query('SELECT id, "sourcePath" FROM bank_papers');
  const prodPaper = new Map(paperRows.map((r) => [r.sourcePath, r.id]));
  const { rows: questionRows } = await client.query('SELECT id, "paperId", "rootNumber" FROM bank_questions');
  const prodQuestion = new Map(questionRows.map((r) => [`${r.paperId}:${r.rootNumber}`, r.id]));
  const { rows: msRows } = await client.query('SELECT "questionId" FROM bank_mark_schemes');
  const alreadyLinked = new Set(msRows.map((r) => r.questionId));
  const { rows: pubRows } = await client.query("SELECT id FROM bank_questions WHERE status = 'published'");
  const published = new Set(pubRows.map((r) => r.id));

  const local = src.prepare(`
    SELECT ms.id            AS local_id,
           ms.answer_md     AS answer_md,
           ms.marking_points AS marking_points,
           ms.total_marks   AS total_marks,
           ms.answer_letter AS answer_letter,
           ms.confidence    AS confidence,
           ms.status        AS status,
           ms.run_id        AS run_id,
           ms.model         AS model,
           ms.prompt_version AS prompt_version,
           qp.source_path   AS question_paper_path,
           q.root_number    AS question_root
    FROM bank_mark_schemes ms
    JOIN bank_questions q ON q.id = ms.question_id
    JOIN bank_papers qp ON qp.id = q.paper_id
  `).all();

  const pending = [];
  let noQuestion = 0;
  let alreadyHas = 0;
  for (const row of local) {
    const paperId = prodPaper.get(row.question_paper_path);
    const questionId = paperId === undefined ? undefined : prodQuestion.get(`${paperId}:${row.question_root}`);
    if (questionId === undefined) { noQuestion += 1; continue; }
    if (alreadyLinked.has(questionId)) { alreadyHas += 1; continue; }
    pending.push({ ...row, questionId, paperId, isPublished: published.has(questionId) });
  }

  const publishedPending = pending.filter((row) => row.isPublished).length;
  const withText = pending.filter(
    (row) => String(row.answer_letter ?? '').trim() || String(row.answer_md ?? '').trim(),
  ).length;

  console.log(`\nlocal linked mark schemes: ${local.length.toLocaleString()}`);
  console.log(`  ${alreadyHas.toLocaleString()} already in production`);
  console.log(`  ${noQuestion.toLocaleString()} point at questions not in production (rows never merged)`);
  console.log(`  ${pending.length.toLocaleString()} would be inserted, ${publishedPending.toLocaleString()} of them on published questions`);
  console.log(`  ${withText.toLocaleString()} of those carry answer text or an answer letter`);

  if (!apply) {
    console.log('\nVerification only. Re-run with --apply to write.');
    process.exit(0);
  }

  if (pending.length === 0) {
    console.log('\nNothing to insert.');
    process.exit(0);
  }

  if (trial) {
    await client.query('BEGIN');
    console.log('\n--trial: inserting inside a transaction that will be rolled back.');
  }

  if (!trial) mkdirSync('backups', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join('backups', `mark-scheme-links-${stamp}.jsonl`);
  if (!trial) writeFileSync(
    backupPath,
    pending.map((row) => JSON.stringify({
      questionId: row.questionId,
      paperId: row.paperId,
      rootNumber: row.question_root,
      localMarkSchemeId: row.local_id,
    })).join('\n') + '\n',
  );
  if (!trial) {
    console.log(`\nbackup: ${backupPath} (${pending.length.toLocaleString()} rows about to be created)`);
    console.log('To undo: DELETE FROM bank_mark_schemes WHERE "questionId" IN (<the questionIds in that file>);');
  }

  let inserted = 0;
  for (let offset = 0; offset < pending.length; offset += BATCH) {
    const slice = pending.slice(offset, offset + BATCH);
    const values = [];
    const params = [];
    slice.forEach((row, index) => {
      const base = index * 10;
      // Every column is cast explicitly: an untyped parameter inside a VALUES
      // list is inferred as text, and the join against an integer "questionId"
      // then fails with `operator does not exist: integer = text`.
      values.push(
        `($${base + 1}::int,$${base + 2}::int,$${base + 3}::int,$${base + 4}::text,`
        + `$${base + 5}::text,$${base + 6}::int,$${base + 7}::text,`
        + `$${base + 8}::double precision,$${base + 9}::text,$${base + 10}::text)`,
      );
      params.push(
        row.questionId,
        row.paperId,
        row.question_root,
        row.answer_md ?? '',
        row.marking_points ?? '[]',
        row.total_marks,
        row.answer_letter,
        row.confidence ?? 0,
        row.status ?? 'needs_review',
        row.run_id,
      );
    });
    // The NOT EXISTS is what makes a re-run a no-op, and what guarantees this
    // can never replace a mark scheme production already has.
    const { rowCount } = await client.query(
      `INSERT INTO bank_mark_schemes
         ("questionId","paperId","rootNumber","answerMd","markingPoints","totalMarks","answerLetter","confidence","status","runId")
       SELECT v.* FROM (VALUES ${values.join(',')}) AS v(
         "questionId","paperId","rootNumber","answerMd","markingPoints","totalMarks","answerLetter","confidence","status","runId")
       WHERE NOT EXISTS (
         SELECT 1 FROM bank_mark_schemes existing WHERE existing."questionId" = v."questionId"
       )`,
      params,
    );
    inserted += rowCount;
    process.stdout.write(`\r  inserted ${inserted.toLocaleString()} / ${pending.length.toLocaleString()}`);
  }
  console.log('\n');
  report(await coverage(), trial ? 'AFTER (trial, about to roll back)' : 'AFTER');
  if (trial) {
    await client.query('ROLLBACK');
    console.log('\nrolled back -- production is unchanged.');
  }
} catch (error) {
  console.error('\nFailed:', error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
  src.close();
}
