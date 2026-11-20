/**
 * Remove "mark schemes" that are really the generic marking notes.
 *
 * IB mark schemes open with a numbered list of general instructions ("Words
 * that are underlined are essential for the mark", "An alternative wording is
 * indicated by a slash", ...). An older heading pass filed each numbered item
 * as the answer to question 1, 2, 3 ... of the paper, and the real answers
 * were left glued together under the last heading. Students opening those
 * questions are shown the notes as if they were the answer.
 *
 * This finds those rows by EXACT text. The notes are identical across papers,
 * so the text of each one is read from the local store (rows from IB mark
 * schemes that are short, carry no marks, and sit beside one huge row) and any
 * production mark scheme whose answerMd equals one of those texts, and has no
 * answer letter, is a notes row. A genuine answer does not repeat verbatim in
 * dozens of papers.
 *
 *   node --env-file=.env scripts/remove-notes-mark-schemes.mjs           # report only
 *   node --env-file=.env scripts/remove-notes-mark-schemes.mjs --apply   # back up, then delete
 *
 * Every deleted row is first written in full to backups/notes-mark-schemes-*.jsonl.
 * Restore by inserting those rows back. The real answers come back through
 * pdf_extraction.bank.repair_ms_roots + scripts/apply-mark-scheme-links.mjs.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import pg from 'pg';

import { pgConfig } from '../lib/db-ssl.ts';

const apply = process.argv.includes('--apply');
const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('Set DIRECT_DATABASE_URL (or DATABASE_URL) first.');
  process.exit(1);
}

const local = new Database('pdf_extraction/bank/extract.db', { readonly: true });
const texts = local
  .prepare(
    `SELECT m.answer_md AS t FROM bank_mark_schemes m
       JOIN bank_papers p ON p.id = m.paper_id
       JOIN (SELECT paper_id, max(length(answer_md)) mx, count(*) n,
                    sum(length(answer_md) < 500) nshort
               FROM bank_mark_schemes GROUP BY paper_id) b ON b.paper_id = m.paper_id
      WHERE p.source_path LIKE '%IB PAST%'
        AND length(m.answer_md) < 500
        AND coalesce(m.total_marks, 0) = 0
        AND m.answer_md NOT GLOB '[A-D]'
        AND b.mx > 5000 AND b.nshort >= 5 AND m.root_number < b.n
      GROUP BY m.answer_md HAVING count(*) >= 2`,
  )
  .all()
  .map((r) => r.t.replaceAll('\0', ''));
console.log(`${texts.length} distinct generic-notes texts read from the local store`);

const client = new pg.Client(pgConfig(url));
await client.connect();
try {
  const { rows } = await client.query(
    `SELECT m.id, m."questionId", m."paperId", m."rootNumber", m."answerMd", m."totalMarks", q.status
       FROM bank_mark_schemes m
       JOIN bank_questions q ON q.id = m."questionId"
      WHERE m."answerLetter" IS NULL AND coalesce(m."totalMarks", 0) = 0
        AND m."answerMd" = ANY($1::text[])`,
    [texts],
  );
  const published = rows.filter((r) => r.status === 'published').length;
  console.log(`${rows.length} production mark schemes are generic notes (${published} on published questions)`);
  const marked = rows.filter((r) => r.totalMarks).length;
  console.log(`${marked} of them carry a nonzero mark total (should be 0)`);
  for (const r of rows.sort(() => Math.random() - 0.5).slice(0, 6)) {
    console.log(`  q${r.questionId} root ${r.rootNumber}: ${r.answerMd.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  if (!apply) {
    console.log('Report only. Re-run with --apply.');
  } else if (rows.length) {
    const dir = 'backups';
    if (!existsSync(dir)) mkdirSync(dir);
    const path = join(dir, `notes-mark-schemes-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    const full = await client.query(`SELECT * FROM bank_mark_schemes WHERE id = ANY($1::int[])`, [rows.map((r) => r.id)]);
    writeFileSync(path, full.rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`backup: ${path} (${full.rows.length} rows)`);
    let deleted = 0;
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 500) {
      const res = await client.query(`DELETE FROM bank_mark_schemes WHERE id = ANY($1::int[])`, [ids.slice(i, i + 500)]);
      deleted += res.rowCount ?? 0;
    }
    console.log(`deleted ${deleted}`);
  }
} finally {
  await client.end();
}
