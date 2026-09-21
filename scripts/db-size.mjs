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

try {
  await client.connect();
} catch (error) {
  // The one failure this script exists to diagnose is also the one that stops
  // it connecting, so it has to say something useful rather than throw a
  // stack trace at exactly the wrong moment.
  if (error?.code === '53300') {
    console.error('\nThe database is out of connection slots (53300), which is');
    console.error('why this could not connect either.\n');
    console.error('Every warm serverless instance holds up to');
    console.error('DB_POOL_MAX + PUBSUB_POOL_MAX sockets and cannot release them');
    console.error('while frozen, so usage tracks instance count rather than');
    console.error('traffic. Options, in order of how quickly they work:\n');
    console.error('  - wait: instances are recycled and slots come back');
    console.error('  - lower DB_POOL_MAX / PUBSUB_POOL_MAX and redeploy');
    console.error('  - put a connection pooler in front of the database\n');
    process.exit(2);
  }
  throw error;
}

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

// Connections, because on this plan they are scarcer than disk. A frozen
// serverless instance cannot run `pg`'s idle reaper, so it holds its sockets
// until the platform recycles it: usage tracks warm instances rather than
// users, and the first symptom of running out is not slowness but
// `53300: remaining connection slots are reserved` on every route at once.
const { rows: [conns] } = await client.query(`
  select current_setting('max_connections')::int as max,
         current_setting('superuser_reserved_connections')::int as reserved,
         count(*) filter (where state = 'active') as active,
         count(*) filter (where state = 'idle') as idle,
         count(*) as total
    from pg_stat_activity
   where datname = current_database()`);

const usable = conns.max - conns.reserved;
console.log(`  connections ${conns.total} of ${usable} usable ` +
            `(${conns.active} active, ${conns.idle} idle; ` +
            `${conns.max} max less ${conns.reserved} superuser-reserved)`);

if (Number(conns.total) >= usable * 0.7) {
  console.log('\n  WARNING: connection usage is high. Each warm serverless');
  console.log('  instance holds up to DB_POOL_MAX + PUBSUB_POOL_MAX sockets and');
  console.log('  cannot release them while frozen, so this grows with instance');
  console.log('  count, not with traffic.');
}

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
