/**
 * Rebuild the disposable RAG index from authoritative platform records.
 *
 * Usage:
 *   npx tsx scripts/reindex-rag.ts
 *   npx tsx scripts/reindex-rag.ts --include-competition
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { reindexRagCorpus } from '../lib/rag-index';

async function main() {
  const includeCompetition = process.argv.includes('--include-competition');
  const result = await reindexRagCorpus({ includeCompetition });
  console.log(`Indexed ${result.indexed.toLocaleString()} source records into ${result.documents.toLocaleString()} official documents.`);
  console.log(`Updated ${result.manifests.toLocaleString()} corpus manifests.`);
}

main()
  .catch((error) => {
    console.error('RAG reindex failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
