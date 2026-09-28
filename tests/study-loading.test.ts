import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describeFailedSources } from '../lib/study-load-errors.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

test('a load where everything came back has no message', () => {
  assert.equal(
    describeFailedSources([
      { name: 'overview', ok: true, status: 200 },
      { name: 'tasks', ok: true, status: 200 },
      { name: 'reviews', ok: true, status: 200 },
    ]),
    null,
  );
});

test('the message names the call that failed and its status', () => {
  // The whole point of the change: "Study data could not be loaded." was the
  // same sentence whichever of the three broke, so it told nobody anything.
  assert.equal(
    describeFailedSources([
      { name: 'overview', ok: true, status: 200 },
      { name: 'tasks', ok: true, status: 200 },
      { name: 'reviews', ok: false, status: 500 },
    ]),
    'Study data could not be loaded: reviews (500).',
  );
});

test('several failures are all named, not just the first', () => {
  assert.equal(
    describeFailedSources([
      { name: 'overview', ok: false, status: 401 },
      { name: 'tasks', ok: true, status: 200 },
      { name: 'reviews', ok: false, status: 503 },
    ]),
    'Study data could not be loaded: overview (401), reviews (503).',
  );
});

test('a superseded Study load cannot write to the screen', async () => {
  // `status` flips from 'loading' to 'authenticated' on mount, which re-runs
  // the effect while the first three requests are still open. Without an
  // abort both sets ran to completion and the loser's banner could land on a
  // screen whose data had arrived intact -- the intermittent "Study data
  // could not be loaded." students actually saw.
  const src = await readFile(path.join(ROOT, 'app/components/StudyCoach.tsx'), 'utf8');

  assert.ok(/new AbortController\(\)/.test(src),
    'the Study load must be abortable, or a superseded one races the live one');
  assert.ok(/fetch\(url, \{ signal \}\)/.test(src),
    'every call in the Study load must carry the signal, or it cannot be aborted');
  assert.ok(/if \(signal\.aborted\) return;/.test(src),
    'an aborted load must not raise a banner; it was replaced, it did not fail');
  assert.ok(/if \(!signal\.aborted\) \{/.test(src),
    'an aborted load must not clear the spinner the live one is showing');
});
