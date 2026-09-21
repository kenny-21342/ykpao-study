/**
 * What the production database is made of, and how close it is to its limit.
 *
 * Written while moving to a 1 GB plan with 419 MB already used and a corpus
 * push pending that adds tens of thousands of rows plus their search index.
 * The restore that preceded it ran the plan out of disk and put the database
 * into read-only mode partway through, so "how much room is left" stopped
 * being a background question.
 *
 *   npx tsx -r dotenv/config scripts/db-size.mjs
 *   npx tsx -r dotenv/config scripts/db-size.mjs --tables
 *
 * Read-only. Reads DIRECT_DATABASE_URL, falling back to DATABASE_URL.
 */
import pg from 'pg';

import { pgConfig } from '../lib/db-ssl.ts';

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('Set DIRECT_DATABASE_URL (or DATABASE_URL) first.');
  process.exit(1);
}

const client = new pg.Client(pgConfig(url));
await client.connect();

const { rows: [summary] } = await client.query(`
  select pg_database_size(current_database()) as bytes,
         pg_size_pretty(pg_database_size(current_database())) as pretty,
         (select count(*) from bank_questions where "bodyMd" <> '') as questions_with_text,
         (select count(*) from bank_mark_schemes where "answerMd" <> '') as schemes_with_text,
         (select count(*) from rag_documents) as rag_documents,
         (select count(*) from rag_chunks) as rag_chunks`);

// The plan's ceiling, so the number means something on its own. Override with
// DB_SIZE_LIMIT_MB when the plan changes.
const limitMb = Number.parseInt(process.env.DB_SIZE_LIMIT_MB ?? '1024', 10);
const usedMb = Math.round(Number(summary.bytes) / 1048576);
const pct = Math.round((usedMb / limitMb) * 100);

console.log(`\n  size        ${summary.pretty}  (${usedMb} of ${limitMb} MB, ${pct}%)`);
console.log(`  questions   ${Number(summary.questions_with_text).toLocaleString()} with text`);
console.log(`  schemes     ${Number(summary.schemes_with_text).toLocaleString()} with text`);
console.log(`  rag         ${Number(summary.rag_documents).toLocaleString()} documents, ` +
            `${Number(summary.rag_chunks).toLocaleString()} chunks`);

if (process.argv.includes('--tables')) {
  const { rows } = await client.query(`
    select relname,
           pg_size_pretty(pg_total_relation_size(c.oid)) as total,
           pg_size_pretty(pg_relation_size(c.oid)) as heap
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
  order by pg_total_relation_size(c.oid) desc
     limit 10`);
  console.log();
  console.table(rows);
}

if (pct >= 85) {
  console.log(`\n  WARNING: ${pct}% of the plan. A bulk write also needs room for the`);
  console.log('  write-ahead log it generates, so the usable headroom is less than');
  console.log('  it looks. Push in batches and re-check between them.');
}

await client.end();
