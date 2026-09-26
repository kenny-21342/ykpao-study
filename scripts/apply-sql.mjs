/**
 * Apply a hand-written migration to Postgres, without psql.
 *
 * Usage:
 *   node scripts/apply-sql.mjs --inspect
 *   node scripts/apply-sql.mjs prisma/migrations/<name>/migration.sql
 *   node scripts/apply-sql.mjs --yes a/migration.sql b/migration.sql
 *   node scripts/apply-sql.mjs --pooled a/migration.sql   # force DATABASE_URL
 *   node scripts/apply-sql.mjs --env-var PRODUCTION_DIRECT_URL a/migration.sql
 *
 * `--env-var` names a different variable to connect through, so a second
 * database can be migrated without editing DATABASE_URL and without a
 * connection string ever being typed on the command line, where it would land
 * in shell history. There are two Neon projects behind this repo -- the corpus
 * lives in `ykpao-study-production`, and `.env` points at the older `smart-edu`
 * project -- so a schema change usually has to be applied to both.
 *
 * Connects through DIRECT_DATABASE_URL when it is set, falling back to
 * DATABASE_URL -- the same order prisma.config.ts uses, and for the same
 * reason: in production DATABASE_URL is Neon's transaction pooler, which is
 * not session-capable and is the wrong end of the connection for DDL.
 *
 * `--inspect` reports which database and schema you are actually pointed at,
 * and whether the tables a migration expects are there. Run it first when a
 * migration fails with "relation ... does not exist": that error means the
 * target is wrong or the search_path is, and neither is worth guessing at
 * against production.
 *
 * This repo's migrations are applied by hand on purpose. Production carries
 * drift that schema.prisma cannot express -- rag_chunks."searchVector" is
 * GENERATED ALWAYS ... STORED, and two indexes use gin_trgm_ops -- so
 * `prisma migrate dev` / `db push` / `migrate deploy` would offer to drop them.
 * `migrate deploy` is additionally unusable here until the history is
 * reconciled: _prisma_migrations records 25 migrations that are not in this
 * folder, and none of the local ones as applied, so deploy would try to create
 * 69 tables that already exist.
 *
 * Two deliberate properties:
 *
 *   - The file is sent as ONE statement, not split on semicolons. Splitting
 *     would cut every `DO $$ ... END $$` block in half, and the idempotency
 *     guards in these migrations are written as exactly that.
 *   - Everything runs inside one transaction, so a file that fails halfway
 *     leaves nothing behind. (Postgres cannot do this for CREATE INDEX
 *     CONCURRENTLY; no migration here uses it, and the script says so rather
 *     than silently dropping the transaction.)
 *
 * It does not write to _prisma_migrations. Nothing else here does either --
 * that table is already out of step with this folder, and having a script
 * quietly add rows to it would make the eventual reconciliation harder.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import pg from 'pg';

import { pgConfig } from '../lib/db-ssl.ts';

const args = process.argv.slice(2);
const assumeYes = args.includes('--yes');
const inspect = args.includes('--inspect');
const forcePooled = args.includes('--pooled');
// The value after --env-var is its argument, not a file.
const files = args.filter(
  (arg, index) => !arg.startsWith('--') && index !== envVarIndexOf(args) + 1,
);

/** Where --env-var sits, or -1. Hoisted so the filter above can use it. */
function envVarIndexOf(list) {
  return list.indexOf('--env-var');
}

if (files.length === 0 && !inspect) {
  console.error('Usage: node scripts/apply-sql.mjs [--inspect] [--yes] <file.sql> ...');
  process.exit(1);
}

const envVarIndex = args.indexOf('--env-var');
const envVar = envVarIndex === -1 ? null : args[envVarIndex + 1];
if (envVarIndex !== -1 && !envVar) {
  console.error('--env-var needs the name of an environment variable.');
  process.exit(1);
}
if (envVar && !process.env[envVar]) {
  console.error(`${envVar} is not set. Add it to .env or export it.`);
  process.exit(1);
}

const direct = envVar ? process.env[envVar] : process.env.DIRECT_DATABASE_URL;
const pooled = process.env.DATABASE_URL;
const connectionString = forcePooled ? pooled : direct || pooled;
if (!connectionString) {
  console.error('Neither DIRECT_DATABASE_URL nor DATABASE_URL is set.');
  process.exit(1);
}

// Host and database only. The credential never reaches the terminal.
const target = new URL(connectionString);
const which = envVar && !forcePooled
  ? envVar
  : forcePooled || !direct
    ? 'DATABASE_URL'
    : 'DIRECT_DATABASE_URL';
console.log(`Target:  ${target.hostname}${target.pathname}  (from ${which})`);
if (!envVar && direct && pooled && new URL(direct).hostname !== new URL(pooled).hostname) {
  console.log(`Note:    DATABASE_URL points at a different host, ${new URL(pooled).hostname}`);
}
for (const file of files) console.log(`Applying: ${file}`);

for (const file of files) {
  if (/CREATE\s+INDEX\s+CONCURRENTLY/i.test(readFileSync(file, 'utf8'))) {
    console.error(
      `\n${file} uses CREATE INDEX CONCURRENTLY, which cannot run inside a ` +
        'transaction. Apply that one statement separately.',
    );
    process.exit(1);
  }
}

/**
 * Where am I actually connected, and is the schema the one I think it is?
 *
 * Prints no credential: database, role, search_path, and a presence check for
 * the tables these migrations build on.
 */
async function report(client) {
  const { rows: [context] } = await client.query(
    'SELECT current_database() AS db, current_user AS role, ' +
      'current_schema() AS schema, current_setting(\'search_path\') AS search_path',
  );
  console.log('\nConnected as');
  console.log(`  database     ${context.db}`);
  console.log(`  role         ${context.role}`);
  console.log(`  schema       ${context.schema}`);
  console.log(`  search_path  ${context.search_path}`);

  const { rows: schemas } = await client.query(
    "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' " +
      "AND nspname <> 'information_schema' ORDER BY nspname",
  );
  console.log(`  schemas      ${schemas.map((row) => row.nspname).join(', ') || '(none)'}`);

  const wanted = [
    'bank_questions', 'bank_papers', 'bank_question_attempts',
    'study_tasks', 'mock_exams', 'grade_boundaries', 'bank_question_skills',
  ];
  const { rows: found } = await client.query(
    'SELECT table_schema, table_name FROM information_schema.tables ' +
      'WHERE table_name = ANY($1) ORDER BY table_name',
    [wanted],
  );
  const bySchema = new Map(found.map((row) => [row.table_name, row.table_schema]));

  console.log('\nTables');
  for (const table of wanted) {
    const schema = bySchema.get(table);
    console.log(`  ${schema ? '✓' : '·'} ${table.padEnd(24)} ${schema ?? 'not found'}`);
  }

  const { rows: counts } = await client.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = current_schema()",
  );
  console.log(`\n${counts[0].n} table(s) in ${context.schema}.`);
}

if (!assumeYes && !inspect) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\nApply to this database? [y/N] ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Nothing applied.');
    process.exit(0);
  }
}

const client = new pg.Client(pgConfig(connectionString));
await client.connect();

try {
  if (inspect) {
    await report(client);
  }

  for (const file of files) {
    const sql = readFileSync(file, 'utf8');
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`✓ ${file}`);
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(`\n✗ Rolled back. ${error.message}`);
  // The one failure worth explaining, because it never means the SQL is wrong.
  if (error.code === '42P01') {
    console.error(
      'A table the migration builds on is missing, so this is the wrong ' +
        'database or the wrong search_path -- not a bad migration. Run ' +
        '`node scripts/apply-sql.mjs --inspect` to see where you are pointed.',
    );
  }
  process.exitCode = 1;
} finally {
  await client.end();
}
