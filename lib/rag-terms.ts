/**
 * Which words in a student's message are worth retrieving on.
 *
 * Extracted from `lib/rag.ts` so it can be unit-tested: that module reaches
 * Prisma at import time, and this decision is pure string handling that got a
 * user-visible answer wrong (see STUDY_META_WORDS).
 */
export const STOP_WORDS = new Set([
  'about', 'after', 'again', 'could', 'explain', 'from', 'have', 'help', 'into',
  'please', 'that', 'their', 'there', 'these', 'this', 'what', 'when', 'where',
  'which', 'with', 'would', 'your',
  // Ordinary function words of three letters or more. The length >= 3 filter
  // below removes "is"/"of"/"to" but kept "any" and "for", which is enough on
  // its own to make a question look like it named subject matter.
  'all', 'and', 'any', 'are', 'been', 'being', 'both', 'but', 'can', 'did',
  'does', 'doesnt', 'dont', 'each', 'for', 'get', 'got', 'had', 'has', 'how',
  'its', 'just', 'many', 'may', 'might', 'more', 'most', 'much', 'not', 'off',
  'once', 'one', 'only', 'onto', 'our', 'out', 'over', 'own', 'said', 'same',
  'some', 'such', 'take', 'than', 'the', 'them', 'then', 'they', 'too', 'use',
  'very', 'was', 'were', 'who', 'whom', 'whose', 'why', 'will', 'you',
  // Verbs that frame a request rather than name anything in it. A real query
  // keeps its subject: "show me notes on osmosis" still searches for
  // "notes osmosis".
  'ask', 'find', 'give', 'know', 'let', 'list', 'look', 'make', 'put', 'say',
  'see', 'show', 'tell', 'think',
]);

/**
 * Words that describe *studying* rather than anything studied.
 *
 * These are not stop words in the ordinary sense -- several are perfectly good
 * content words elsewhere, and "study" in particular is one in IB Psychology
 * ("Describe one study related to one model of memory"). They are listed
 * separately because they must not be used *on their own* to retrieve
 * evidence: asking "What should I study today?" retrieved that psychology
 * question and a 0607 maths question reading "Each student studies at least
 * one of the sciences", because `study` was a search term and the lexical
 * matcher matches any one term. The answer had nothing to do with either.
 *
 * So a query keeps them when it also carries a real content term, and
 * retrieves nothing when they are all it has.
 */
export const STUDY_META_WORDS = new Set([
  'study', 'studies', 'studying', 'studied', 'revise', 'revising', 'revision',
  'today', 'tonight', 'tomorrow', 'now', 'next', 'week', 'weekend',
  'should', 'shall', 'must', 'need', 'want', 'like', 'doing', 'focus',
  'plan', 'planning', 'schedule', 'suggest', 'suggestion', 'suggestions',
  'recommend', 'recommendation', 'advice', 'anything', 'something', 'else',
  'start', 'begin', 'best', 'good', 'better', 'time', 'first',
]);

/**
 * The terms worth searching for, or `[]` when the query names no subject
 * matter at all. Callers must treat `[]` as "retrieve nothing" rather than as
 * "match everything"; see STUDY_META_WORDS for why that distinction exists.
 */
export function searchTerms(query: string): string[] {
  const terms = [...new Set(
    query
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.replace(/[^a-z0-9-]/g, ''))
      .filter((term) => term.length >= 3 && !STOP_WORDS.has(term)),
  )];
  if (terms.length === 0) return [];
  const content = terms.filter((term) => !STUDY_META_WORDS.has(term));
  // Dropping the meta words is also a precision win when real terms remain:
  // the psychology query above searches for "describe model memory" and not
  // additionally for every chunk containing the word "study".
  return content.slice(0, 6);
}

/**
 * How many of a query's content terms a passage must actually contain to be
 * shown as evidence.
 *
 * The retriever matches on any single term (that is what keeps a long
 * question from returning nothing), so a physics question about a rod came
 * back citing a computer-science question about compressing a sound file and
 * an economics question: each shared one incidental word. Ranking cannot fix
 * that -- the rows are simply not about the question -- so require real
 * overlap, and show no Evidence panel when nothing has it.
 */
export function requiredTermMatches(termCount: number): number {
  if (termCount <= 1) return termCount;
  return Math.min(3, Math.ceil(termCount / 2));
}

/** True when `text` contains enough distinct query terms (prefix match, as the index does). */
export function passageMatchesQuery(text: string, terms: string[]): boolean {
  const need = requiredTermMatches(terms.length);
  if (need === 0) return true;
  const words = new Set(text.toLowerCase().replace(/[^a-z0-9-]+/g, ' ').split(' ').filter(Boolean));
  let hits = 0;
  for (const term of terms) {
    for (const word of words) {
      if (word.startsWith(term)) {
        hits += 1;
        break;
      }
    }
    if (hits >= need) return true;
  }
  return false;
}
