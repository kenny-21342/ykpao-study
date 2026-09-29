import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';

import { sharedVisionCredential } from '../../lib/ai-credentials.ts';

/**
 * Which provider marks a diagram answer.
 *
 * The shared gateway serves vision on the same key and endpoint as the shared
 * text models, which matters because the two older shared vision paths are
 * both in doubt (SiliconFlow's last success was 18 days before 29 Sep 2026,
 * and the current Gemini flash models answer 503). Routing vision there is
 * opt-in through SHARED_AI_VISION_MODEL so that leaving it unset is exactly
 * the previous behaviour -- these pin that both ways round.
 */

const KEYS = [
  'SHARED_AI_VISION_MODEL', 'SHARED_AI_API_KEY', 'SHARED_AI_BASE_URL',
  'SILICONFLOW_API_KEY', 'GEMINI_API_KEY', 'VISION_MODEL', 'GEMINI_MODEL',
  'DEEPSEEK_API_KEY', 'DEEPSEEK_API_URL', 'V3_OPENAI_API_KEY',
  'V3_OPENAI_CHAT_COMPLETIONS_URL',
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('the gateway is used for vision when a vision model is named', () => {
  process.env.SHARED_AI_API_KEY = 'k';
  process.env.SHARED_AI_BASE_URL = 'https://gateway.example/v1';
  process.env.SHARED_AI_VISION_MODEL = 'gpt-6-astra';

  const c = sharedVisionCredential();
  assert.equal(c?.provider, 'openai-compatible', 'the gateway speaks image_url, not Gemini');
  assert.equal(c?.model, 'gpt-6-astra');
  assert.equal(c?.endpoint, 'https://gateway.example/v1/chat/completions');
  assert.equal(c?.source, 'shared');
});

test('the gateway wins over SiliconFlow when it is configured for vision', () => {
  process.env.SILICONFLOW_API_KEY = 'sf';
  process.env.SHARED_AI_API_KEY = 'k';
  process.env.SHARED_AI_BASE_URL = 'https://gateway.example/v1';
  process.env.SHARED_AI_VISION_MODEL = 'gpt-5.5';

  assert.equal(sharedVisionCredential()?.model, 'gpt-5.5');
});

test('without a vision model named, SiliconFlow is still chosen as before', () => {
  process.env.SILICONFLOW_API_KEY = 'sf';
  process.env.SHARED_AI_API_KEY = 'k';
  process.env.SHARED_AI_BASE_URL = 'https://gateway.example/v1';

  const c = sharedVisionCredential();
  assert.match(c?.endpoint ?? '', /siliconflow/i, 'naming no vision model must change nothing');
  assert.equal(c?.model, 'Qwen/Qwen3-VL-32B-Instruct');
});

test('an empty vision model is treated as unset, not as a model named ""', () => {
  process.env.SILICONFLOW_API_KEY = 'sf';
  process.env.SHARED_AI_API_KEY = 'k';
  process.env.SHARED_AI_BASE_URL = 'https://gateway.example/v1';
  process.env.SHARED_AI_VISION_MODEL = '   ';

  assert.match(sharedVisionCredential()?.endpoint ?? '', /siliconflow/i);
});

test('the gateway is not used for vision without a key and a base url', () => {
  process.env.SHARED_AI_VISION_MODEL = 'gpt-6-astra';
  process.env.GEMINI_API_KEY = 'g';

  // No SHARED_AI_API_KEY/BASE_URL: naming a model alone must not invent an
  // endpoint. Falls through to Gemini exactly as before.
  assert.equal(sharedVisionCredential()?.provider, 'gemini');
});

test('with nothing configured there is no shared vision credential', () => {
  assert.equal(sharedVisionCredential(), null);
});
