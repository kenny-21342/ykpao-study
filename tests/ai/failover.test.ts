import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';

import { resetModelHealth } from '../../lib/ai-model-pool.ts';
import { chat, DeepSeekError } from '../../lib/ai.ts';
import type { TextCredential } from '../../lib/ai-credentials.ts';

/**
 * Model failover on the shared key.
 *
 * AI marking was down for every user for 36 days because the model the
 * platform was configured for stopped being served by the shared gateway,
 * while three other models on the same key and endpoint answered normally. The
 * grading path passes `maxAttempts: 1` (it fans out, so it must not retry), so
 * a single failure ended the grade -- there was nothing to carry it to a model
 * that worked.
 *
 * These assert the two axes stay separate: `maxAttempts` retries one model,
 * the candidate list walks to another.
 */

const shared = (model: string): TextCredential => ({
  source: 'shared',
  apiKey: 'k',
  endpoint: 'https://gateway.example/v1/chat/completions',
  model,
});

const byok = (model: string): TextCredential => ({ ...shared(model), source: 'user' });

const realFetch = globalThis.fetch;
let envBefore: string | undefined;

beforeEach(() => {
  resetModelHealth();
  envBefore = process.env.SHARED_AI_FALLBACK_MODELS;
  process.env.SHARED_AI_FALLBACK_MODELS = 'beta,gamma';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetModelHealth();
  if (envBefore === undefined) delete process.env.SHARED_AI_FALLBACK_MODELS;
  else process.env.SHARED_AI_FALLBACK_MODELS = envBefore;
});

/** A fetch stub driven by a per-model script of statuses. */
function stubGateway(plan: Record<string, Array<number | 'ok'>>) {
  const asked: string[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const model = JSON.parse(init.body).model as string;
    asked.push(model);
    const next = plan[model]?.shift() ?? 500;
    if (next === 'ok') {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: `answered by ${model}` } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ error: { message: 'upstream error' } }), { status: next });
  }) as unknown as typeof fetch;
  return asked;
}

// --- chat() ---------------------------------------------------------------

test('a dead model fails over even with maxAttempts 1, which is what grading passes', async () => {
  const asked = stubGateway({ alpha: [500], beta: ['ok'] });
  const out = await chat([{ role: 'user', content: 'x' }], {
    credential: shared('alpha'),
    maxAttempts: 1,
    budgetMs: 20_000,
  });
  assert.equal(out, 'answered by beta');
  assert.deepEqual(asked, ['alpha', 'beta'], 'one request each, no retry of the dead model');
});

test('the model that answered is reported, not the one asked for', async () => {
  stubGateway({ alpha: [503], beta: ['ok'] });
  let served: string | null = null;
  await chat([{ role: 'user', content: 'x' }], {
    credential: shared('alpha'),
    maxAttempts: 1,
    budgetMs: 20_000,
    onModel: (m) => { served = m; },
  });
  assert.equal(served, 'beta');
});

test('a 404 model_not_found moves on instead of throwing', async () => {
  const asked = stubGateway({ alpha: [404], beta: ['ok'] });
  const out = await chat([{ role: 'user', content: 'x' }], {
    credential: shared('alpha'),
    maxAttempts: 1,
    budgetMs: 20_000,
  });
  assert.equal(out, 'answered by beta');
  assert.deepEqual(asked, ['alpha', 'beta']);
});

test('a rejected key fails at once rather than proving it on every model', async () => {
  const asked = stubGateway({ alpha: [401], beta: ['ok'], gamma: ['ok'] });
  await assert.rejects(
    chat([{ role: 'user', content: 'x' }], {
      credential: shared('alpha'),
      maxAttempts: 1,
      budgetMs: 20_000,
    }),
    (err: unknown) => err instanceof DeepSeekError && err.status === 401,
  );
  assert.deepEqual(asked, ['alpha'], 'no other model can fix a rejected key');
});

test('a rate limit is not carried to the next model', async () => {
  const asked = stubGateway({ alpha: [429], beta: ['ok'] });
  await assert.rejects(
    chat([{ role: 'user', content: 'x' }], {
      credential: shared('alpha'),
      maxAttempts: 1,
      budgetMs: 20_000,
    }),
    (err: unknown) => err instanceof DeepSeekError && err.status === 429,
  );
  assert.deepEqual(asked, ['alpha'], 'the quota belongs to the key every candidate shares');
});

test('a student’s own failing key is not failed over to another model', async () => {
  const asked = stubGateway({ alpha: [500], beta: ['ok'] });
  await assert.rejects(
    chat([{ role: 'user', content: 'x' }], {
      credential: byok('alpha'),
      maxAttempts: 1,
      budgetMs: 20_000,
    }),
    (err: unknown) => err instanceof DeepSeekError,
  );
  assert.deepEqual(asked, ['alpha']);
});

test('the whole list can be exhausted, and the last error is what surfaces', async () => {
  const asked = stubGateway({ alpha: [500], beta: [502], gamma: [503] });
  await assert.rejects(
    chat([{ role: 'user', content: 'x' }], {
      credential: shared('alpha'),
      maxAttempts: 1,
      budgetMs: 20_000,
    }),
    (err: unknown) => err instanceof DeepSeekError && err.status === 503,
  );
  assert.deepEqual(asked, ['alpha', 'beta', 'gamma']);
});

test('a second call skips the model the first one found dead', async () => {
  stubGateway({ alpha: [500], beta: ['ok'] });
  await chat([{ role: 'user', content: 'x' }], {
    credential: shared('alpha'), maxAttempts: 1, budgetMs: 20_000,
  });
  const asked = stubGateway({ alpha: ['ok'], beta: ['ok'] });
  await chat([{ role: 'user', content: 'x' }], {
    credential: shared('alpha'), maxAttempts: 1, budgetMs: 20_000,
  });
  assert.deepEqual(asked, ['beta'], 'the cooldown spares every later grade the wasted call');
});

test('with no fallbacks configured the behaviour is exactly as before', async () => {
  delete process.env.SHARED_AI_FALLBACK_MODELS;
  const asked = stubGateway({ alpha: [500, 'ok'] });
  const out = await chat([{ role: 'user', content: 'x' }], {
    credential: shared('alpha'),
    maxAttempts: 2,
    budgetMs: 20_000,
  });
  assert.equal(out, 'answered by alpha');
  assert.deepEqual(asked, ['alpha', 'alpha'], 'one bounded retry of the one model');
});
