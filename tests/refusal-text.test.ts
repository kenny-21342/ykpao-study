import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasGradableText } from '../lib/grading-router.ts';

/**
 * A model refusal must never be mistaken for a transcript.
 *
 * Asked to transcribe a copyrighted poem, the vision model returns, with a
 * 200 OK and a normal token bill, "Sorry, I can't provide a verbatim
 * transcription of the copyrighted poem shown in the image." The pipeline
 * had no reason to doubt a 200, so it stored that as the question body and
 * logged the work as `ok` -- which meant it never retried. 138 Literature
 * and History rows were carrying one.
 *
 * The danger is not the missing text. It is that the refusal is fluent
 * English: `hasGradableText` returns true for it, so the grading router sends
 * the student's answer to be marked against an apology, and the marker
 * confidently scores it zero for not addressing a question it cannot see.
 * That is the F16 bug the `hasQuestionText` gate closed, reopened through a
 * door the gate does not watch.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const REFUSALS = [
  "Sorry, I can't provide a verbatim transcription of the copyrighted poem shown in the image.",
  'Sorry, I can’t provide or reconstruct the copyrighted literary passage shown or redacted in the image.',
  'I cannot provide a transcription of this copyrighted material.',
  'I’m unable to transcribe the passage shown here.',
];

test('a refusal still reads as gradable text, which is why it must be stopped earlier', () => {
  // Not a bug in hasGradableText -- it asks "are there words here", and there
  // are. Pinned so nobody 'fixes' this by teaching the grader to spot
  // refusals: by then the wrong text is already in the question bank, feeding
  // search, hints and revision as well as grading.
  for (const refusal of REFUSALS) {
    assert.equal(hasGradableText(refusal), true, `expected prose: ${refusal}`);
  }
});

test('the production pusher holds back refusal text', async () => {
  const src = await readFile(join(root, 'scripts/apply-transcriptions.mjs'), 'utf8');

  const match = src.match(/const REFUSAL = (\/.+\/i);/);
  assert.ok(match, 'apply-transcriptions.mjs no longer defines a refusal pattern');

  const pattern = new RegExp(match[1].slice(1, -2), 'i');
  for (const refusal of REFUSALS) {
    assert.ok(pattern.test(refusal), `pusher would ship this refusal: ${refusal}`);
  }

  // Anchored, deliberately. An unanchored /unable to/ matched a legitimate
  // Computer Science question about a programmer who was unable to compile a
  // program -- the quality watcher raised exactly that false alarm before it
  // was anchored, and here it would silently withhold a real transcript.
  assert.ok(
    !pattern.test('The programmer is unable to explain why the program fails.'),
    'the refusal pattern is unanchored and will withhold legitimate questions',
  );

  assert.match(
    src,
    /resolve\(questionsToPush,/,
    'the filtered question list is not the one being pushed',
  );
  assert.match(
    src,
    /resolve\(schemesToPush,/,
    'the filtered mark-scheme list is not the one being pushed',
  );
});
