/**
 * Push transcribed question and mark-scheme text from the local extraction
 * store to production.
 *
 * `pdf_extraction/bank/merge_to_neon.py` cannot do this, for exactly the reason
 * `scripts/apply-mark-totals.mjs` records: it is insert-only. Its
 * `ON CONFLICT ("paperId","rootNumber") DO NOTHING` skips every question that
 * already exists, and all 70,045 of them already do — so a completed
 * transcription run merges cleanly and writes nothing at all. This is the
 * update path for the columns a later pipeline stage fills in:
 *
 *     bank_questions.bodyMd, .totalMarks, .difficulty
 *     bank_mark_schemes.answerMd
 *
 * Idempotent by construction: every UPDATE carries a `WHERE <column> = ''`
 * (or `IS NULL`) guard, so re-running is a no-op rather than a second write,
 * and a run interrupted halfway can simply be repeated.
 *
 *   node scripts/apply-transcriptions.mjs              # verify only, writes nothing
 *   node scripts/apply-transcriptions.mjs --apply      # verify, then update
 *   node scripts/apply-transcriptions.mjs --apply --subject 0625
 *   node scripts/apply-transcriptions.mjs --source other.db
 *
 * Reads DIRECT_DATABASE_URL, falling back to DATABASE_URL. Use the direct
 * (non `-pooler`) endpoint: this holds one session across tens of thousands of
 * updates, and PgBouncer drops it partway through. That is how the first full
 * merge run was lost.
 *
 * AFTER THIS SCRIPT, RUN THE REINDEX. Filling `bodyMd` with SQL bypasses the
 * RAG index entirely — `refreshRagIndex` only fires on the in-request path in
 * lib/bank-transcription.ts. Without `scripts/reindex-bank.ts` the text lands
 * and search still cannot see any of it.
 */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import pg from 'pg';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const sourcePath = flag('--source', 'pdf_extraction/bank/extract.db');
const subject = flag('--subject', null);

/** Rows per UPDATE ... FROM (VALUES ...). Large enough to be fast, small
 *  enough that one failed batch is cheap to retry. */
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
const client = new pg.Client({ connectionString: url });

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

const counts = async () => {
  const { rows } = await client.query(`
    SELECT
      (SELECT count(*) FROM bank_questions WHERE "bodyMd" <> '')            AS q_with_text,
      (SELECT count(*) FROM bank_questions WHERE "totalMarks" IS NOT NULL)  AS q_with_marks,
      (SELECT count(*) FROM bank_questions WHERE difficulty IS NOT NULL)    AS q_with_difficulty,
      (SELECT count(*) FROM bank_mark_schemes WHERE "answerMd" <> '')       AS ms_with_text
  `);
  return rows;
};

/**
 * Apply one batched UPDATE ... FROM (VALUES ...).
 *
 * `cast` names the Postgres types for each column, because a VALUES list
 * arriving through parameters is otherwise all `text` and the comparison
 * against an integer key fails.
 */
async function updateBatch(sql, rows, arity) {
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
  console.log(`source:    ${sourcePath}${subject ? `  (subject ${subject})` : ''}\n`);

  console.log('BEFORE');
  show(await counts());

  // Papers are matched on `sourcePath`, which is the same key
  // merge_to_neon.py uses and is unique on both sides.
  const { rows: paperRows } = await client.query('SELECT id, "sourcePath" FROM bank_papers');
  const prodPaperId = new Map(paperRows.map((r) => [r.sourcePath, r.id]));
  console.log(`\n${prodPaperId.size.toLocaleString()} papers in production`);

  const subjectClause = subject
    ? `JOIN bank_subjects s ON s.id = p.subject_id AND s.code = @subject`
    : '';

  const localQuestions = src.prepare(`
    SELECT p.source_path, q.root_number, q.body_md, q.total_marks, q.difficulty
    FROM bank_questions q
    JOIN bank_papers p ON p.id = q.paper_id
    ${subjectClause}
    WHERE q.body_md IS NOT NULL AND trim(q.body_md) <> ''
  `).all(subject ? { subject } : {});

  const localSchemes = src.prepare(`
    SELECT p.source_path, m.root_number, m.answer_md
    FROM bank_mark_schemes m
    JOIN bank_papers p ON p.id = m.paper_id
    ${subjectClause}
    WHERE m.answer_md IS NOT NULL AND trim(m.answer_md) <> ''
  `).all(subject ? { subject } : {});

  // A local paper with no production counterpart is a paper that was never
  // merged. Report it rather than silently dropping the work.
  const resolve = (rows, label) => {
    const resolved = [];
    let orphaned = 0;
    for (const row of rows) {
      const id = prodPaperId.get(row.source_path);
      if (id === undefined) { orphaned += 1; continue; }
      resolved.push({ ...row, prodPaperId: id });
    }
    if (orphaned > 0) {
      console.log(`  ! ${orphaned.toLocaleString()} ${label} sit on papers not present in production (run merge_to_neon.py first)`);
    }
    return resolved;
  };

  console.log(`\nlocal rows with text:`);
  const questions = resolve(localQuestions, 'questions');
  const schemes = resolve(localSchemes, 'mark schemes');
  console.log(`  ${questions.length.toLocaleString()} questions`);
  console.log(`  ${schemes.length.toLocaleString()} mark schemes`);

  if (!apply) {
    console.log('\nVerification only. Re-run with --apply to write.');
    process.exit(0);
  }

  // --- questions -----------------------------------------------------------
  // `bodyMd` is only written where it is still empty, so a question a human has
  // since corrected is never overwritten by a re-run. `totalMarks` and
  // `difficulty` are filled only where NULL for the same reason.
  // Every column out of a parameterised VALUES list arrives as `text`, so each
  // one that meets an integer column is cast explicitly. Without the casts on
  // `total_marks` and `difficulty` the COALESCE fails with a type mismatch —
  // and it would fail on the first real batch, after the run had already been
  // paid for.
  const QUESTION_SQL = `
    UPDATE bank_questions AS t
       SET "bodyMd"     = CASE WHEN t."bodyMd" = '' THEN v.body_md ELSE t."bodyMd" END,
           "totalMarks" = COALESCE(t."totalMarks", v.total_marks::int),
           difficulty   = COALESCE(t.difficulty, v.difficulty::int)
      FROM (VALUES __VALUES__) AS v(paper_id, root_number, body_md, total_marks, difficulty)
     WHERE t."paperId"    = v.paper_id::int
       AND t."rootNumber" = v.root_number::int
       AND (t."bodyMd" = '' OR t."totalMarks" IS NULL OR t.difficulty IS NULL)
  `;

  let qUpdated = 0;
  for (let i = 0; i < questions.length; i += BATCH) {
    const slice = questions.slice(i, i + BATCH).map((r) => [
      r.prodPaperId, r.root_number, r.body_md, r.total_marks ?? null, r.difficulty ?? null,
    ]);
    qUpdated += await updateBatch(QUESTION_SQL, slice, 5);
    process.stdout.write(`\r  questions: ${Math.min(i + BATCH, questions.length).toLocaleString()}/${questions.length.toLocaleString()} — ${qUpdated.toLocaleString()} updated`);
  }
  if (questions.length) process.stdout.write('\n');

  // --- mark schemes --------------------------------------------------------
  // Keyed through the question, because bank_mark_schemes has no (paperId,
  // rootNumber) unique constraint of its own in production.
  const SCHEME_SQL = `
    UPDATE bank_mark_schemes AS t
       SET "answerMd" = v.answer_md
      FROM (VALUES __VALUES__) AS v(paper_id, root_number, answer_md)
      JOIN bank_questions q
        ON q."paperId" = v.paper_id::int AND q."rootNumber" = v.root_number::int
     WHERE t."questionId" = q.id
       AND t."answerMd" = ''
  `;

  let msUpdated = 0;
  for (let i = 0; i < schemes.length; i += BATCH) {
    const slice = schemes.slice(i, i + BATCH).map((r) => [r.prodPaperId, r.root_number, r.answer_md]);
    msUpdated += await updateBatch(SCHEME_SQL, slice, 3);
    process.stdout.write(`\r  mark schemes: ${Math.min(i + BATCH, schemes.length).toLocaleString()}/${schemes.length.toLocaleString()} — ${msUpdated.toLocaleString()} updated`);
  }
  if (schemes.length) process.stdout.write('\n');

  console.log(`\nrows updated: ${qUpdated.toLocaleString()} questions, ${msUpdated.toLocaleString()} mark schemes`);

  console.log('\nAFTER');
  show(await counts());

  console.log('\nNext: npx tsx scripts/reindex-bank.ts');
  console.log('Without it the text is in the database but invisible to search.');
} catch (error) {
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
} finally {
  src.close();
  await client.end().catch(() => {});
}
