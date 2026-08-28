import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { MAX_EXAM_ITEMS, GRADING_CONCURRENCY } from '../lib/mock-exam-limits.ts';

/**
 * The mock-exam size invariant.
 *
 * Every path that *creates* a mock exam and the single path that *grades* one
 * must clamp to the same constant. When they diverged, `submit` truncated the
 * item list with `take:` — a student answered twenty questions, twelve came
 * back graded, and eight vanished with nothing in the UI to explain it.
 *
 * These assertions are deliberately source-level: the failure mode is a
 * hardcoded number reappearing in one of the three files, which no behavioural
 * test of the current code would notice.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const GENERATORS = [
  'app/api/mock-exams/generate/route.ts',
  'lib/predicted-paper.ts',
];
const SUBMITTER = 'app/api/mock-exams/[id]/submit/route.ts';

async function source(relative: string): Promise<string> {
  return readFile(join(root, relative), 'utf8');
}

test('the limit is a sane positive integer', () => {
  assert.ok(Number.isInteger(MAX_EXAM_ITEMS) && MAX_EXAM_ITEMS > 0);
  assert.ok(Number.isInteger(GRADING_CONCURRENCY) && GRADING_CONCURRENCY > 0);
});

test('every generation path imports the shared constant', async () => {
  for (const file of GENERATORS) {
    const src = await source(file);
    assert.match(
      src,
      /import\s*\{[^}]*\bMAX_EXAM_ITEMS\b[^}]*\}\s*from\s*['"]@\/lib\/mock-exam-limits['"]/,
      `${file} must import MAX_EXAM_ITEMS from lib/mock-exam-limits`,
    );
  }
});

test('submission imports the same shared constant', async () => {
  const src = await source(SUBMITTER);
  assert.match(
    src,
    /import\s*\{[^}]*\bMAX_EXAM_ITEMS\b[^}]*\}\s*from\s*['"]@\/lib\/mock-exam-limits['"]/,
  );
  // The grading ceiling must be the constant, never a literal.
  assert.match(src, /take:\s*MAX_EXAM_ITEMS/);
  assert.doesNotMatch(
    src,
    /take:\s*\d+/,
    'submit must not cap the item list with a hardcoded number',
  );
});

test('every generation path clamps the requested question count', async () => {
  for (const file of GENERATORS) {
    const src = await source(file);
    assert.match(
      src,
      /Math\.min\(\s*\n?\s*MAX_EXAM_ITEMS|Math\.min\(MAX_EXAM_ITEMS/,
      `${file} must clamp the requested question count to MAX_EXAM_ITEMS`,
    );
  }
});

test('a model-planned paper clamps while flattening the plan too', async () => {
  // A model routinely returns more questions than the prompt asks for, so for
  // the paths that still ask one, a clamp on `targetCount` alone is not enough
  // — the flattening loop that builds the persisted items must break on the
  // ceiling as well.
  //
  // The plain mock generator is no longer one of those paths: it selects with a
  // query and passes the ceiling to `selectBankQuestions` as `maxItems`, which
  // `tests/mock-exam-packing.test.ts` covers behaviourally. Predicted papers
  // still call a model, so the source-level guard stays where it still bites.
  const src = await source('lib/predicted-paper.ts');
  assert.match(
    src,
    /flatItems\.length\s*>=\s*MAX_EXAM_ITEMS/,
    'lib/predicted-paper.ts must enforce MAX_EXAM_ITEMS while flattening the AI plan',
  );
});

test('the bank generator hands the ceiling to the selector', async () => {
  // The invariant has not gone away, only moved: whatever the request asks for,
  // the number of items persisted is bounded by MAX_EXAM_ITEMS.
  const src = await source('app/api/mock-exams/generate/route.ts');
  assert.match(
    src,
    /maxItems:\s*targetCount/,
    'generate must pass the clamped count to selectBankQuestions as maxItems',
  );
});

test('generation and submission declare the same function budget', async () => {
  const budgets = await Promise.all(
    [...GENERATORS.filter((f) => f.startsWith('app/')), SUBMITTER].map(async (file) => {
      const src = await source(file);
      const match = src.match(/export const maxDuration\s*=\s*(\d+)/);
      assert.ok(match, `${file} must declare maxDuration`);
      return Number(match![1]);
    }),
  );
  // An exam may never be created under a longer budget than it is graded under.
  assert.equal(new Set(budgets).size, 1, `maxDuration diverged: ${budgets.join(', ')}`);
});
