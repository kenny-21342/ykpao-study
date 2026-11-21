/**
 * Insert bank_assets rows production does not have yet, copied from the local store.
 *
 * The merge only carries image rows for questions it merges, so a mark-scheme
 * strip can reference an image production has never heard of; apply-mark-scheme-strips
 * then leaves that mark scheme alone ("reference an image row production does not
 * have"). This adds just those rows. Additive and idempotent (ON CONFLICT DO NOTHING);
 * it does not upload any file -- do that with scripts/upload-bank-assets.ts.
 *
 *   node --env-file=.env.neon --env-file=.env scripts/insert-missing-bank-assets.mjs --sql-from-strips          # report
 *   node ... scripts/insert-missing-bank-assets.mjs --sql-from-strips --apply
 *
 * --sql-from-strips: the digests are those used by local mark-scheme strips whose
 * mark scheme is published in production but still shows nothing.
 */
import Database from 'better-sqlite3';
import pg from 'pg';
import { pgConfig } from '../lib/db-ssl.ts';

const apply = process.argv.includes('--apply');
const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
const src = new Database('pdf_extraction/bank/extract.db', { readonly: true });
const client = new pg.Client(pgConfig(url));
await client.connect();
try {
  const { rows: empty } = await client.query(`
    SELECT p."sourcePath" path, q."rootNumber" root FROM bank_mark_schemes ms
    JOIN bank_questions q ON q.id = ms."questionId" JOIN bank_papers p ON p.id = q."paperId"
    WHERE ms.status='published' AND q.status='published' AND coalesce(btrim(ms."answerLetter"),'')=''
      AND NOT EXISTS (SELECT 1 FROM bank_mark_scheme_strips s WHERE s."markSchemeId"=ms.id)`);
  const want = new Map();
  const q = src.prepare(`SELECT a.sha256,a.kind,a.relative_path,a.width,a.height,a.byte_size,a.source_page,a.bbox,a.source_dpi
    FROM bank_mark_schemes ms JOIN bank_questions q ON q.id=ms.question_id JOIN bank_papers p ON p.id=q.paper_id
    JOIN bank_mark_scheme_strips s ON s.mark_scheme_id=ms.id JOIN bank_assets a ON a.id=s.asset_id
    WHERE p.source_path=? AND q.root_number=?`);
  for (const r of empty) for (const a of q.all(r.path, r.root)) want.set(a.sha256, a);
  const shas = [...want.keys()];
  const have = new Set();
  for (let i = 0; i < shas.length; i += 1000) {
    const { rows } = await client.query('SELECT sha256 FROM bank_assets WHERE sha256 = ANY($1::text[])', [shas.slice(i, i + 1000)]);
    rows.forEach((r) => have.add(r.sha256));
  }
  const missing = shas.filter((s) => !have.has(s));
  console.log(`${shas.length} images used by empty published mark schemes; ${missing.length} not in production's bank_assets`);
  if (apply && missing.length) {
    let n = 0;
    for (let i = 0; i < missing.length; i += 500) {
      const part = missing.slice(i, i + 500).map((s) => want.get(s));
      const values = [];
      const marks = part.map((a, j) => {
        values.push(a.sha256, a.kind, a.relative_path, a.width, a.height, a.byte_size, a.source_page, a.bbox, a.source_dpi ?? 200);
        const b = j * 9;
        return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9})`;
      });
      const res = await client.query(`INSERT INTO bank_assets (sha256,kind,"relativePath",width,height,"byteSize","sourcePage",bbox,"sourceDpi") VALUES ${marks.join(',')} ON CONFLICT (sha256) DO NOTHING`, values);
      n += res.rowCount ?? 0;
    }
    console.log(`inserted ${n} rows. Undo: DELETE FROM bank_assets WHERE sha256 IN (those digests) AND id NOT IN (SELECT "assetId" FROM bank_mark_scheme_strips) -- or leave them, they are inert.`);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.argv.includes('--write-shas') ? process.argv[process.argv.indexOf('--write-shas') + 1] : '/dev/null', missing.join('\n') + '\n');
  } else if (!apply) console.log('Report only. Re-run with --apply.');
} finally { await client.end(); }
