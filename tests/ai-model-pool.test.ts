import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';

import { candidateModels, noteModelOutcome, resetModelHealth, modelHealthSnapshot } from '../lib/ai-model-pool.ts';
import type { TextCredential } from '../lib/ai-credentials.ts';

/*
 * These import the pool directly, which works under `npm run test:node`
 * (bare `node --experimental-strip-types`) because the pool's only import is
 * `import type`, and strip-types erases it. `lib/ai.ts` imports `@/types/ai`
 * for real, and bare node does not resolve the `@/` alias -- which is why the
 * behavioural tests for `chat()` itself live in tests/ai/ and run under tsx.
 */

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

let envBefore: string | undefined;

beforeEach(() => {
  resetModelHealth();
  envBefore = process.env.SHARED_AI_FALLBACK_MODELS;
  process.env.SHARED_AI_FALLBACK_MODELS = 'beta,gamma';
});

afterEach(() => {
  resetModelHealth();
  if (envBefore === undefined) delete process.env.SHARED_AI_FALLBACK_MODELS;
  else process.env.SHARED_AI_FALLBACK_MODELS = envBefore;
});

// --- the pool ------------------------------------------------------------

test('a student’s own key is never given a model they did not choose', () => {
  assert.deepEqual(candidateModels(byok('their-model')), ['their-model']);
});

test('the shared key tries the configured model first, then the fallbacks', () => {
  assert.deepEqual(candidateModels(shared('alpha')), ['alpha', 'beta', 'gamma']);
});

test('the configured model is not duplicated when it is also in the fallback list', () => {
  process.env.SHARED_AI_FALLBACK_MODELS = 'beta,alpha,gamma';
  assert.deepEqual(candidateModels(shared('alpha')), ['alpha', 'beta', 'gamma']);
});

test('a model that reported "not being served" drops behind the healthy ones', () => {
  noteModelOutcome('alpha', 503);
  assert.deepEqual(candidateModels(shared('alpha')), ['beta', 'gamma', 'alpha']);
});

test('a rate limit does not deprioritise a model, because the quota is the key’s', () => {
  noteModelOutcome('alpha', 429);
  assert.deepEqual(candidateModels(shared('alpha')), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(modelHealthSnapshot(), []);
});

test('a rejected key does not deprioritise a model either', () => {
  noteModelOutcome('alpha', 401);
  assert.deepEqual(candidateModels(shared('alpha')), ['alpha', 'beta', 'gamma']);
});

test('a success clears an earlier failure immediately', () => {
  noteModelOutcome('alpha', 500);
  noteModelOutcome('alpha', 'ok');
  assert.deepEqual(candidateModels(shared('alpha')), ['alpha', 'beta', 'gamma']);
});

test('the cooldown expires, so a recovered model returns without a deploy', () => {
  noteModelOutcome('alpha', 503);
  const later = Date.now() + Number(process.env.AI_MODEL_COOLDOWN_MS || 10 * 60_000) + 1;
  assert.deepEqual(candidateModels(shared('alpha'), later), ['alpha', 'beta', 'gamma']);
});

test('every candidate is still tried when all of them are cooling', () => {
  for (const m of ['alpha', 'beta', 'gamma']) noteModelOutcome(m, 503);
  // Order is preserved and nothing is dropped: a stale cooldown must never be
  // the reason a student gets no grade at all.
  assert.deepEqual(candidateModels(shared('alpha')), ['alpha', 'beta', 'gamma']);
});

