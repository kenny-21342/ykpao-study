/**
 * One-off: copy catalogue content from the dev database into the production
 * database.
 *
 * The two databases hold identical column definitions for every table below
 * (verified column-by-column), so this is a straight row copy with no
 * transformation. It deliberately copies *content* only -- no users, notes,
 * attempts, or sessions -- because production should start clean on anything
 * that represents a person.
 *
 * Source is DATABASE_URL from .env (the dev database); target is passed as
 * TARGET_DATABASE_URL so the production credential never lands in a file.
 *
 * Safe to abort and re-run: every table is skipped unless it is empty at the
 * target, so a partial run cannot double-insert.
 */
import pg from 'pg';

import { pgConfig } from '../lib/db-ssl.ts';
import 'dotenv/config';

const BATCH = 500;

/**
 * FK order matters: past_paper_questions references past_papers, which
 * references subjects; rag_chunks references rag_documents.
 */
const TABLES = [
  'subjects',
  'past_papers',
  'past_paper_questions',
  'rag_documents',
  'rag_chunks',
  'rag_corpus_manifests',
  'competition_questions',
];

/**
 * Rows the copy deliberately leaves behind. The dev database holds a handful of
 * documents owned by a test account -- private cloud notes and textbooks -- and
 * those are one person's material, not platform content. Production starts with
 * no user-owned documents at all, so the owning account never has to come with
 * them.
 */
const FILTERS = {
  rag_documents: '"ownerId" IS NULL',
  rag_chunks: '"documentId" IN (SELECT id FROM rag_documents WHERE "ownerId" IS NULL)',
};

/** Sequences that must be advanced past the copied ids, or the next insert collides. */
const SEQUENCES = {
  subjects: 'subjects_id_seq',
  past_papers: 'past_papers_id_seq',
  competition_questions: 'competition_questions_id_seq',
};

const SOURCE_URL = process.env.DATABASE_URL;
const TARGET_URL = process.env.TARGET_DATABASE_URL;

if (!SOURCE_URL) throw new Error('DATABASE_URL (source) is not set');
if (!TARGET_URL) throw new Error('TARGET_DATABASE_URL is not set');
if (SOURCE_URL === TARGET_URL) throw new Error('source and target are the same database');

const quote = (id) => `"${id.replace(/"/g, '""')}"`;

/**
 * Generated columns cannot be written to -- rag_chunks."searchVector" is
 * GENERATED ALWAYS AS ... STORED, and postgres recomputes it on insert.
 */
async function writableColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
        AND is_generated = 'NEVER'
      ORDER BY ordinal_position`,
    [table]
  );
  return rows.map((r) => r.column_name);
}

async function copyTable(source, target, table) {
  const columns = await writableColumns(target, table);
  const sourceColumns = await writableColumns(source, table);

  const missing = columns.filter((c) => !sourceColumns.includes(c));
  if (missing.length) {
    throw new Error(`${table}: target has columns the source lacks: ${missing.join(', ')}`);
  }

  const { rows: [{ count: existing }] } = await target.query(
    `SELECT count(*)::int AS count FROM ${quote(table)}`
  );
  if (existing > 0) {
    console.log(`  ${table}: already holds ${existing} rows -- skipped`);
    return { table, copied: 0, skipped: true };
  }

  const colList = columns.map(quote).join(', ');
  const where = FILTERS[table] ? `WHERE ${FILTERS[table]}` : '';
  let copied = 0;

  for (let offset = 0; ; offset += BATCH) {
    // Ordered by the primary key so pagination is stable across batches.
    const { rows } = await source.query(
      `SELECT ${colList} FROM ${quote(table)} ${where} ORDER BY 1 OFFSET $1 LIMIT $2`,
      [offset, BATCH]
    );
    if (rows.length === 0) break;

    const values = [];
    const placeholders = rows.map((row, r) => {
      const slots = columns.map((col, c) => {
        values.push(row[col]);
        return `$${r * columns.length + c + 1}`;
      });
      return `(${slots.join(', ')})`;
    });

    await target.query(
      `INSERT INTO ${quote(table)} (${colList}) VALUES ${placeholders.join(', ')}`,
      values
    );
    copied += rows.length;
    process.stdout.write(`\r  ${table}: ${copied} rows`);
  }

  process.stdout.write(`\r  ${table}: ${copied} rows\n`);
  return { table, copied, skipped: false };
}

async function main() {
  const source = new pg.Client(pgConfig(SOURCE_URL));
  const target = new pg.Client(pgConfig(TARGET_URL));
  await source.connect();
  await target.connect();

  try {
    const { rows: [{ count: users }] } = await target.query(
      'SELECT count(*)::int AS count FROM users'
    );
    console.log(`target has ${users} user account(s) -- none will be modified\n`);

    const results = [];
    for (const table of TABLES) {
      results.push(await copyTable(source, target, table));
    }

    console.log('\nresetting sequences');
    for (const [table, sequence] of Object.entries(SEQUENCES)) {
      const { rows: [{ next }] } = await target.query(
        `SELECT setval('${sequence}', GREATEST((SELECT max(id) FROM ${quote(table)}), 1)) AS next`
      );
      console.log(`  ${sequence} -> ${next}`);
    }

    console.log('\nverifying row counts against source');
    let mismatched = 0;
    for (const { table } of results) {
      const [{ rows: [s] }, { rows: [t] }] = await Promise.all([
        source.query(
          `SELECT count(*)::int AS count FROM ${quote(table)} ` +
            (FILTERS[table] ? `WHERE ${FILTERS[table]}` : '')
        ),
        target.query(`SELECT count(*)::int AS count FROM ${quote(table)}`),
      ]);
      const ok = s.count === t.count;
      if (!ok) mismatched += 1;
      console.log(`  ${ok ? 'ok  ' : 'DIFF'} ${table}: source ${s.count}, target ${t.count}`);
    }

    if (mismatched > 0) {
      console.error(`\n${mismatched} table(s) do not match the source`);
      process.exitCode = 1;
    } else {
      console.log('\nevery table matches the source');
    }
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
