/**
 * Apply a hand-written migration to Postgres, without psql.
 *
 * Usage:
 *   node scripts/apply-sql.mjs prisma/migrations/<name>/migration.sql
 *   node scripts/apply-sql.mjs --yes a/migration.sql b/migration.sql
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

const args = process.argv.slice(2);
const assumeYes = args.includes('--yes');
const files = args.filter((arg) => !arg.startsWith('--'));

if (files.length === 0) {
  console.error('Usage: node scripts/apply-sql.mjs [--yes] <file.sql> [more.sql ...]');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Source it into the environment first.');
  process.exit(1);
}

// Host and database only. The credential never reaches the terminal.
const target = new URL(connectionString);
console.log(`Target:  ${target.hostname}${target.pathname}`);
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

if (!assumeYes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\nApply to this database? [y/N] ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('Nothing applied.');
    process.exit(0);
  }
}

const client = new pg.Client({ connectionString });
await client.connect();

try {
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
  process.exitCode = 1;
} finally {
  await client.end();
}
