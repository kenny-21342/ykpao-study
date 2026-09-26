/**
 * Where a retrieved RAG document sends the reader.
 *
 * Split out of `lib/rag.ts` so it carries no Prisma import: this is pure URL
 * logic shared by the indexer (which writes `route`), global search and the
 * copilot's citations, and it should be testable without a database.
 *
 * `indexBankQuestion` wrote a bare `/bank` for every bank document -- 88,209 of
 * them -- on the reasoning, true at the time, that "no page reads a question id
 * from the URL". `app/components/routing.ts` has read `?bqid=` since, so the
 * deep link exists and those documents point at a corpus index page instead of
 * using it. A citation that lands at the top of a 66,756-question bank is
 * indistinguishable from a broken one.
 *
 * Resolved on read rather than by backfilling `rag_documents.route`: that would
 * be an 88,209-row UPDATE, and a bulk UPDATE's WAL is what filled the disk and
 * put the database into read-only on 25 Sep. The indexer writes the deep link
 * for documents it touches from here on; this covers the rows already written,
 * for every caller at once.
 */

export const BANK_QUESTION_ROUTE = '/?tab=practice&bqid=';

/** The subset of an indexed document this module needs. */
export type RoutableDocument = {
  documentKey: string;
  sourceRecordId: string;
  route?: string | null;
  metadata?: unknown;
};

/**
 * The bank question a document belongs to, or null if it isn't a bank document.
 *
 * Note the asymmetry in what identifies that question: a `bank-question`
 * document's `sourceRecordId` IS the question id, but a `bank-markscheme`
 * document's is the *mark scheme's* id, and the question is in
 * `metadata.pairedSourceRecordId`. Reading `sourceRecordId` for both does not
 * fail loudly -- mark scheme ids are also valid question ids -- it silently
 * links a mark scheme to an unrelated question.
 */
export function bankQuestionIdOf(row: RoutableDocument): string | null {
  const id = (() => {
    if (row.documentKey.startsWith('bank-question:')) return row.sourceRecordId;
    if (!row.documentKey.startsWith('bank-markscheme:')) return null;
    const metadata = row.metadata;
    const paired = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>).pairedSourceRecordId
      : null;
    return typeof paired === 'string' || typeof paired === 'number' ? String(paired) : null;
  })();
  return id && /^[0-9]+$/.test(id) ? id : null;
}

/** The deep link for a bank document; every other document keeps its own route. */
export function indexedRoute(row: RoutableDocument): string | null {
  const bankQuestionId = bankQuestionIdOf(row);
  return bankQuestionId ? `${BANK_QUESTION_ROUTE}${bankQuestionId}` : row.route ?? null;
}
