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
