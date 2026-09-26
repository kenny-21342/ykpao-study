import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bankQuestionIdOf, indexedRoute, BANK_QUESTION_ROUTE } from '../lib/rag-routes.ts';

/**
 * Where a retrieved document sends the student.
 *
 * `indexBankQuestion` wrote a bare `/bank` for 88,209 documents, on a
 * limitation that stopped being true once `app/components/routing.ts` learned
 * to read `?bqid=`. Those rows are resolved on read rather than backfilled, so
 * this mapping is the only thing standing between a citation and the top of a
 * 66,756-question bank -- and it is easy to "simplify" into the bug the third
 * test below describes.
 */

const doc = (over: Partial<Parameters<typeof indexedRoute>[0]> = {}) => ({
  documentKey: 'bank-question:47552',
  sourceRecordId: '47552',
  route: '/bank',
  metadata: {} as unknown,
  ...over,
}) as Parameters<typeof indexedRoute>[0];

test('a bank question deep-links to itself rather than the bank index', () => {
  assert.equal(indexedRoute(doc()), `${BANK_QUESTION_ROUTE}47552`);
  assert.equal(bankQuestionIdOf(doc()), '47552');
});

test('a mark scheme links to its question, not to its own record id', () => {
  // The asymmetry this guards: a `bank-markscheme` document's `sourceRecordId`
  // is the *mark scheme's* id. Real row, 26 Sep: `bank-markscheme:68880`
  // carries `sourceRecordId` 49886, and 49886 is itself a valid question id --
  // so reading the wrong field does not throw or return nothing, it silently
  // links a mark scheme to an unrelated question.
  const markScheme = doc({
    documentKey: 'bank-markscheme:68880',
    sourceRecordId: '49886',
    metadata: { pairedSourceRecordId: '68880' },
  });
  assert.equal(indexedRoute(markScheme), `${BANK_QUESTION_ROUTE}68880`);
  assert.equal(bankQuestionIdOf(markScheme), '68880');
});

test('a mark scheme with no paired id falls back rather than guessing', () => {
  const orphan = doc({ documentKey: 'bank-markscheme:68880', sourceRecordId: '49886', metadata: {} });
  assert.equal(bankQuestionIdOf(orphan), null);
  assert.equal(indexedRoute(orphan), '/bank');
});

test('the past-paper corpus keeps its own id space', () => {
  // `past_paper_questions` and `bank_questions` number independently, so
  // treating a past-paper record id as a `bqid` opens whichever bank question
  // happens to share the number. Its own route is already correct.
  const pastPaper = doc({
    documentKey: 'past-paper-question:50372',
    sourceRecordId: '50372',
    route: '/?tab=questions-db&qid=50372',
  });
  assert.equal(bankQuestionIdOf(pastPaper), null);
  assert.equal(indexedRoute(pastPaper), '/?tab=questions-db&qid=50372');
});

test('a non-numeric id is refused instead of building a broken link', () => {
  const junk = doc({ documentKey: 'bank-question:oops', sourceRecordId: 'oops' });
  assert.equal(bankQuestionIdOf(junk), null);
  assert.equal(indexedRoute(junk), '/bank');
});

test('a document with no route at all stays null', () => {
  const routeless = doc({ documentKey: 'announcement:abc', sourceRecordId: 'abc', route: null });
  assert.equal(indexedRoute(routeless), null);
});
