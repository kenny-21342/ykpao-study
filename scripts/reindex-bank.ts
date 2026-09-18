/**
 * Index transcribed bank questions into the RAG corpus.
 *
 * `scripts/reindex-rag.ts` calls `reindexRagCorpus`, which rebuilds *everything*
 * — every note, page, resource, announcement, thread and all 12,398 legacy
 * past-paper questions — on every run. That is the right tool for the weekly
 * cron and the wrong one after a transcription push, which touches only the
 * bank and may touch tens of thousands of rows at a time.
 *
 * It is also not optional. Filling `bank_questions.bodyMd` with SQL bypasses the
 * index completely: `refreshRagIndex` only fires on the in-request path in
 * lib/bank-transcription.ts, so after `scripts/apply-transcriptions.mjs` the
 * text is in the database and ⌘K, progressive hints and the AI tutor still
 * cannot see a word of it.
 *
 *   npx tsx scripts/reindex-bank.ts --dry-run     # count what would be indexed
 *   npx tsx scripts/reindex-bank.ts               # index everything missing
 *   npx tsx scripts/reindex-bank.ts --all         # re-index even if present
 *   npx tsx scripts/reindex-bank.ts --subject 0625
 *   npx tsx scripts/reindex-bank.ts --limit 500
 *
 * Safe to interrupt and re-run: by default it only visits questions that have
 * text and do not yet have a `rag_documents` row, so a second run resumes where
 * the first stopped.
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { indexBankQuestion } from '../lib/rag-index';

/**
 * Questions indexed before pausing to report. Also the transaction-free unit of
 * work: each question is independent, so a failure costs one row, not a batch.
 */
const REPORT_EVERY = 250;

/** Concurrency. `indexBankQuestion` is several queries per call; this keeps the
 *  pooled connection busy without exhausting it. */
const CONCURRENCY = 8;

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const all = process.argv.includes('--all');
  const subject = arg('--subject');
  const limit = Number(arg('--limit') ?? '0') || undefined;

  // Only questions with retrievable text are candidates. `indexBankQuestion`
  // enforces the same rule itself and deletes the document when it fails, but
  // selecting them here keeps the run proportional to the work.
  const where = {
    status: 'published',
    bodyMd: { not: '' },
    ...(subject ? { paper: { subject: { code: subject } } } : {}),
  } as const;

  const total = await prisma.bankQuestion.count({ where });
  console.log(`${total.toLocaleString()} published bank questions carry text${subject ? ` in ${subject}` : ''}.`);

  if (total === 0) {
    console.log('Nothing to index. Run scripts/apply-transcriptions.mjs --apply first.');
    return;
  }

  // Which of those already have a document. The key shape is set by
  // lib/rag-index.ts: `bank-question:<id>`.
  const existing = all
    ? new Set<number>()
    : new Set(
        (
          await prisma.ragDocument.findMany({
            where: { documentKey: { startsWith: 'bank-question:' } },
            select: { documentKey: true },
          })
        ).map((d) => Number(d.documentKey.slice('bank-question:'.length))),
      );

  const candidates = await prisma.bankQuestion.findMany({
    where,
    select: { id: true },
    orderBy: { id: 'asc' },
    ...(limit ? { take: limit } : {}),
  });
  const todo = candidates.map((q) => q.id).filter((id) => all || !existing.has(id));

  console.log(`${existing.size.toLocaleString()} already indexed, ${todo.length.toLocaleString()} to do.`);

  if (dryRun) {
    console.log('\nDry run. Re-run without --dry-run to index.');
    return;
  }

  let done = 0;
  let failed = 0;
  const started = Date.now();

  // A hand-rolled worker pool rather than Promise.all over everything: the
  // corpus is large enough that indexing it in one go would open tens of
  // thousands of concurrent queries.
  const queue = [...todo];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const id = queue.pop();
        if (id === undefined) return;
        try {
          await indexBankQuestion(id);
        } catch (error) {
          failed += 1;
          if (failed <= 5) {
            console.warn(`  ! question ${id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        done += 1;
        if (done % REPORT_EVERY === 0) {
          const rate = done / ((Date.now() - started) / 1000);
          const left = Math.round((todo.length - done) / Math.max(rate, 0.001));
          process.stdout.write(
            `\r  ${done.toLocaleString()}/${todo.length.toLocaleString()} — ${rate.toFixed(0)}/s — ~${Math.floor(left / 60)}m left`,
          );
        }
      }
    }),
  );
  if (done >= REPORT_EVERY) process.stdout.write('\n');

  const documents = await prisma.ragDocument.count({
    where: { documentKey: { startsWith: 'bank-question:' } },
  });

  // Not every question with text ends up with a document, and that is correct.
  // `indexBankQuestion` drops anything `isRetrievableText` rejects -- a one-word
  // transcript is ranking noise, not a passage -- and it does so by deleting the
  // document and returning, without throwing. So those questions are neither
  // `done` nor `failed`: the run reported them as indexed, the document count
  // did not move, and the next run picked the same ones up again. Counting them
  // here is what stops this script looking like it never converges. The floor is
  // real: most of it is 0400 Art & Design, whose questions are one-word prompts.
  const [{ count: unindexed }] = await prisma.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count
      FROM bank_questions q
      LEFT JOIN rag_documents d ON d."documentKey" = 'bank-question:' || q.id
     WHERE q.status = 'published'
       AND coalesce(q."bodyMd", '') <> ''
       AND d.id IS NULL`;

  console.log(`\nIndexed ${(done - failed - unindexed).toLocaleString()} questions${failed ? `, ${failed.toLocaleString()} failed` : ''}.`);
  if (unindexed > 0) {
    console.log(`${unindexed.toLocaleString()} carry text too short to retrieve and are deliberately not indexed.`);
  }
  console.log(`${documents.toLocaleString()} bank questions are now in the RAG corpus.`);
}

main()
  .catch((error) => {
    console.error('Bank reindex failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
