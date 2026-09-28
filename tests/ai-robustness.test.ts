import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Robustness guarantees for the AI-backed surfaces.
 *
 * Every LLM call in the app funnels through `lib/ai.ts`, so the timeout and
 * retry policy is asserted there. `fetch` has no default timeout: without an
 * explicit one, a stalled upstream hangs until the *platform* kills the whole
 * invocation, and the student watches a spinner and then gets an opaque
 * gateway error.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('lib/ai.ts bounds every request with an abort signal and a retry ceiling', async () => {
  const src = await readFile(join(root, 'lib/ai.ts'), 'utf8');
  assert.match(src, /new AbortController\(\)/, 'chat() must be cancellable');
  assert.match(src, /signal:\s*controller\.signal/, 'the fetch must carry the abort signal');
  assert.match(src, /setTimeout\(\(\) => controller\.abort\(\)/, 'the call must time out');
  assert.match(src, /maxAttempts/, 'retries must be bounded by an attempt count');
  assert.match(src, /budgetMs/, 'retries must be bounded by a wall-clock budget');
});

test('timeouts surface as an explanatory error, not a hang', async () => {
  const src = await readFile(join(root, 'lib/ai.ts'), 'utf8');
  // Routes return DeepSeekError.message verbatim, so the message is user-facing.
  assert.match(src, /did not respond in time/i);
  assert.match(src, /new DeepSeekError\(\s*\n?\s*'The AI service did not respond in time[^']*',\s*\n?\s*504/);
});

test('vision transcription cannot outlast its caller', async () => {
  const src = await readFile(join(root, 'lib/vision.ts'), 'utf8');
  // The retry ladder sleeps up to 69s; a per-call deadline keeps it from
  // consuming the whole 60s mock-exam submission it runs inside.
  assert.match(src, /AbortSignal\.timeout\(/, 'vision requests must time out');
  assert.match(src, /DEFAULT_VISION_BUDGET_MS/, 'vision retries need an overall budget');
  assert.doesNotMatch(
    src,
    /await sleep\(delay\)/,
    'backoff must be clamped to the remaining budget, not slept blindly',
  );
});

test('every AI route declares a function budget', async () => {
  // A route that calls the LLM without maxDuration inherits the platform
  // default, which is far shorter than a completion takes.
  const apiRoot = join(root, 'app/api');
  const routes: string[] = [];

  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name === 'route.ts') routes.push(full);
    }
  }
  await walk(apiRoot);

  const missing: string[] = [];
  for (const file of routes) {
    const src = await readFile(file, 'utf8');
    const callsAI = /from ['"]@\/lib\/ai['"]/.test(src) && /\b(chat|chatJSON)\s*[<(]/.test(src);
    if (!callsAI) continue;
    if (!/export const maxDuration\s*=\s*\d+/.test(src)) {
      missing.push(file.slice(root.length + 1));
    }
  }

  assert.deepEqual(missing, [], `AI routes without maxDuration: ${missing.join(', ')}`);
});

/**
 * A vision grade must be given a deadline derived from the invocation it runs
 * inside, not a literal that drifts away from it.
 *
 * This is the bug that shipped: lib/vision.ts carried one 45s budget with a
 * 40s per-attempt ceiling for every caller, and /api/practice declared a
 * Hobby-era `maxDuration = 60` beside it. Measured against the production
 * model a single-image grade runs past 40s, so both attempts aborted and a
 * student who drew their working got the attempt back unscored. Two numbers
 * that have to agree, sitting in different files, agreeing by coincidence.
 */
test('the practice route derives its vision budget from its own function budget', async () => {
  const src = await readFile(join(root, 'app/api/practice/route.ts'), 'utf8');

  const declared = src.match(/export const maxDuration\s*=\s*(\d+)/);
  assert.ok(declared, 'the practice route must declare maxDuration');
  const maxDuration = Number(declared![1]);

  const budget = src.match(/const VISION_GRADE_BUDGET_MS\s*=\s*(.+);/);
  assert.ok(budget, 'the practice route must set a vision grading budget');
  assert.match(
    budget![1],
    /maxDuration/,
    'the budget must be derived from maxDuration, not written as a literal that can drift from it',
  );

  assert.match(
    src,
    /budgetMs:\s*VISION_GRADE_BUDGET_MS/,
    'the derived budget must actually be handed to runVisionGrading',
  );

  // A grade this route pays for is worthless if the invocation dies before the
  // attempt row is written, so the budget has to leave room after the call.
  assert.ok(
    maxDuration >= 90,
    `maxDuration ${maxDuration}s is too short for a vision grade measured at ~30s and over`,
  );
});

/**
 * The same rule for the other grader, which is where it was broken.
 *
 * The mock-exam route already derived a correct per-wave budget from its own
 * maxDuration -- and handed it only to `chatJSON`. Vision grades fell through
 * to lib/vision.ts's module default, a figure sized for a different caller
 * entirely, and timed out on every drawn answer while the right number sat
 * unused a few lines above.
 */
test('the mock-exam route hands its wave budget to the vision grader too', async () => {
  const src = await readFile(join(root, 'app/api/mock-exams/[id]/submit/route.ts'), 'utf8');

  assert.match(
    src,
    /const GRADING_BUDGET_MS\s*=[^;]*maxDuration/,
    'the wave budget must be derived from maxDuration',
  );

  const call = src.match(/runVisionGrading\(\{[\s\S]*?\}\)/);
  assert.ok(call, 'the submit route must grade image answers through runVisionGrading');
  assert.match(
    call![0],
    /budgetMs:\s*GRADING_BUDGET_MS/,
    'the vision grade must run under the same wave budget as the text grade, not a module default',
  );
});

/**
 * Submitting a sat paper must never be refused for want of an API key.
 *
 * This route was the one grading path in the app with no degraded mode: it
 * returned 503 from the credential gate before a single answer was read, so a
 * student without a key could sit ninety minutes of a paper, press Submit, and
 * lose the lot. Every other grading path -- /api/practice,
 * /api/daily-challenge -- records the attempt and explains itself.
 *
 * Asserted on the source rather than by invoking the handler because the
 * handler needs a session, a database and a paper; the property that matters
 * is structural and one grep proves it.
 */
test('mock-exam submit degrades instead of refusing when AI is off', async () => {
  const src = await readFile(join(root, 'app/api/mock-exams/[id]/submit/route.ts'), 'utf8');

  assert.doesNotMatch(
    src,
    /if \(!access\.ok\) \{\s*\n\s*return NextResponse\.json\(/,
    'the credential gate must not return early -- a sat paper has to be persisted',
  );
  assert.match(src, /const aiEnabled = access\.ok/, 'availability must become a flag, not an exit');
  assert.match(
    src,
    /\(!questionContent\.trim\(\) \|\| !aiEnabled\)/,
    'with AI off, a non-keyed item must take the existing ungraded branch',
  );
  assert.match(
    src,
    /aiDisabled: !aiEnabled/,
    'the response must say why items came back unmarked',
  );
});

/**
 * Multiple choice still marks itself with no provider at all, which is what
 * makes the degraded path worth having rather than a blanket "unmarked".
 */
test('mock-exam submit still grades an answer key without a model', async () => {
  const src = await readFile(join(root, 'app/api/mock-exams/[id]/submit/route.ts'), 'utf8');
  const keyIndex = src.indexOf('const keyGrade = gradeAgainstKey(');
  const ungradedIndex = src.indexOf('|| !aiEnabled)');
  assert.ok(keyIndex > 0, 'the keyed branch must exist');
  assert.ok(
    keyIndex < ungradedIndex,
    'the keyed branch must run before the ungraded one, or MCQ would go unmarked with AI off',
  );
});

/**
 * Every route derives its own budgets from its own `maxDuration`, so raising a
 * ceiling propagates instead of needing a second edit. These two carried
 * Hobby-era 60s values long after the project moved to Pro.
 */
test('the SSE streams outlive the connection lifetime they advertise', async () => {
  const config = await readFile(join(root, 'lib/stream-config.ts'), 'utf8');
  const lifetime = Number(/DEFAULT_STREAM_LIFETIME_MS = ([\d_]+)/.exec(config)?.[1].replace(/_/g, ''));
  assert.ok(Number.isFinite(lifetime), 'the default stream lifetime must be readable');

  // Was two routes; the notebook's page stream went with the notebook on
  // 28 Sep 2026, leaving notifications as the only SSE endpoint.
  for (const route of ['app/api/notifications/stream/route.ts']) {
    const src = await readFile(join(root, route), 'utf8');
    const max = Number(/export const maxDuration = (\d+)/.exec(src)?.[1]);
    assert.ok(Number.isFinite(max), `${route} must declare maxDuration`);
    assert.ok(
      lifetime < max * 1000,
      `${route}: a stream that outlives maxDuration is killed mid-flight, which the browser cannot tell from a network fault`,
    );
  }
});
