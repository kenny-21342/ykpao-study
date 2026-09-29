/**
 * Remove the legacy past-paper question documents from the RAG index.
 *
 * These are the `past-paper-question:` documents for the 12,398-row text
 * corpus. Their route is `/?tab=questions-db&qid=`, which opens the old
 * browser the platform no longer practises on, and the id in it belongs to
 * that corpus -- it means nothing to the crop-first bank, so the citation
 * could not be repointed, only stopped. Indexing them meant a search result or
 * an AI citation dropped a student into a surface they were not meant to
 * reach.
 *
 * `lib/rag-index.ts` no longer writes them, and keeps `past-paper-question:`
 * in its prune list so a full rebuild would clear them eventually. This exists
 * because "eventually" is the next weekly rebuild, which is roughly four hours
 * and lands after the launch.
 *
 *   node scripts/drop-legacy-question-docs.mjs            # count only, writes nothing
 *   node scripts/drop-legacy-question-docs.mjs --apply    # count, then delete
 *
 * Chunks are removed by the schema's own cascade (RagChunk.documentId,
 * onDelete: Cascade), so this deletes documents only and the chunk count below
 * is reported to show what goes with them.
 *
 * NOT touched: `past-paper:` catalogue documents. Those route to /papers/[id],
 * which is a live surface, and the past-paper reader stays.
 */
import pg from 'pg';

import { pgConfig } from '../lib/db-ssl.ts';

const url = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('Set DIRECT_DATABASE_URL (or DATABASE_URL) first.');
  process.exit(1);
}
if (url.includes('-pooler')) {
  console.error('That is the pooled endpoint. Use the direct one (drop "-pooler" from the host).');
  process.exit(1);
}

const apply = process.argv.includes('--apply');
const PREFIX = 'past-paper-question:';

const client = new pg.Client(pgConfig(url));
await client.connect();
try {
  const { rows: [before] } = await client.query(
    `SELECT
       count(*) FILTER (WHERE d."documentKey" LIKE $1)::int AS legacy_docs,
       count(*)::int AS all_docs
     FROM rag_documents d`,
    [`${PREFIX}%`],
  );
  const { rows: [chunks] } = await client.query(
    `SELECT count(*)::int AS n
     FROM rag_chunks c
     JOIN rag_documents d ON d.id = c."documentId"
     WHERE d."documentKey" LIKE $1`,
    [`${PREFIX}%`],
  );
  const { rows: [keep] } = await client.query(
    `SELECT count(*)::int AS n FROM rag_documents WHERE "documentKey" LIKE 'past-paper:%'`,
  );

  console.log(`legacy question documents : ${before.legacy_docs.toLocaleString()}`);
  console.log(`  their chunks            : ${chunks.n.toLocaleString()} (removed by cascade)`);
  console.log(`documents in total        : ${before.all_docs.toLocaleString()}`);
  console.log(`paper catalogue kept      : ${keep.n.toLocaleString()} ('past-paper:', routes to /papers)`);

  if (!apply) {
    console.log('\nCount only. Re-run with --apply to delete.');
  } else {
    const deleted = await client.query(
      `DELETE FROM rag_documents WHERE "documentKey" LIKE $1`,
      [`${PREFIX}%`],
    );
    const { rows: [after] } = await client.query(
      `SELECT count(*)::int AS legacy, (SELECT count(*)::int FROM rag_documents) AS all_docs
       FROM rag_documents WHERE "documentKey" LIKE $1`,
      [`${PREFIX}%`],
    );
    console.log(`\ndeleted                   : ${deleted.rowCount.toLocaleString()} documents`);
    console.log(`legacy remaining          : ${after.legacy}`);
    console.log(`documents now             : ${after.all_docs.toLocaleString()}`);
  }
} finally {
  await client.end();
}
