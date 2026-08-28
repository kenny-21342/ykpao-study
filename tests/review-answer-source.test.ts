import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * A review card must never be created with nothing on the back of it.
 *
 * This is the invariant behind the defect it replaces: `upsertMistakeReview`
 * wrote a fixed sentence into `ReviewItem.answer` whenever it had no model
 * answer and no mark scheme, and because that was *persisted* rather than
 * substituted at render time, a third of a real queue became cards asking the
 * student to recall an answer that was never stored.
 *
 * The writers take a database, so these are source-level assertions in the
 * style of `tests/mock-exam-limits.test.ts` — the failure mode is someone
 * reintroducing a default, which no behavioural test of the current code would
 * notice. Source-level rather than imported for a second reason too:
 * `lib/learning.ts` pulls in the Prisma client, which the bare node test runner
 * cannot resolve through the `@/` alias.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function learningSource(): Promise<string> {
  return readFile(join(root, 'lib/learning.ts'), 'utf8');
}

test('the placeholder is still exported so the queue filters can exclude it', async () => {
  // Rows written before the fix are already in the database; the queue queries
  // match on this exact string to keep them out, so it must stay exported even
  // though nothing writes it any more.
  const src = await learningSource();
  assert.match(src, /export const PLACEHOLDER_ANSWER\s*=/);
  assert.match(src, /'Rework this question and compare each step with the mark scheme\.'/);
});

test('neither writer falls back to a default answer', async () => {
  const src = await learningSource();
  // The constant may be *declared*, but must never be used as an `||` fallback
  // when composing the answer that gets stored.
  assert.doesNotMatch(
    src,
    /answer[^\n]*\|\|\s*PLACEHOLDER_ANSWER/,
    'an answer must never default to the placeholder',
  );
  assert.doesNotMatch(
    src,
    /\|\|\s*'Rework this question/,
    'the placeholder literal must not be reintroduced as a fallback',
  );
});

test('both writers bail out rather than store an empty answer', async () => {
  const src = await learningSource();
  // The legacy writer has nothing but text to offer, so an empty answer ends it.
  assert.match(
    src,
    /if \(!answer\) return null;/,
    'upsertMistakeReview must return null when it has no answer text',
  );
  // The bank writer can be answered by an image instead, so it checks both.
  assert.match(
    src,
    /if \(!text && !input\.hasMarkSchemeStrips\) return null;/,
    'upsertBankMistakeReview must return null with neither text nor strips',
  );
});

test('an answer key outranks mark-scheme prose on a bank card', async () => {
  const src = await learningSource();
  // "Answer: C" is the complete answer to a multiple-choice question; the prose
  // beside it is marking guidance for a different, longer question.
  assert.match(
    src,
    /input\.answerLetter[\s\S]{0,120}`Answer: \$\{input\.answerLetter\}`/,
    'the answer letter must take precedence over answerMd',
  );
});

test('every review queue excludes the placeholder', async () => {
  // Three separate queries serve cards or count them; all three must filter, or
  // a stranded row reappears in whichever one was missed.
  for (const file of [
    'app/api/learning/reviews/route.ts',
    'app/api/learning/overview/route.ts',
    'app/api/dashboard/route.ts',
  ]) {
    const src = await readFile(join(root, file), 'utf8');
    assert.match(
      src,
      /answer:\s*\{\s*not:\s*PLACEHOLDER_ANSWER\s*\}/,
      `${file} must exclude placeholder cards from the queue`,
    );
  }
});
