import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { sharedVisionCredential, siliconflowKey } from '../lib/ai-credentials.ts';

/**
 * Both moved from lib/vision.ts to lib/ai-credentials.ts under bring-your-own-
 * key: vision.ts no longer holds a key of its own, so the owner's shared
 * credential is resolved alongside every other credential. The behaviour under
 * test is unchanged — which variable is consulted, and when the alias is safe.
 */
/** The backend the owner's shared key selects, or null if it selects none. */
function sharedVisionProvider(): string | null {
  return sharedVisionCredential()?.provider ?? null;
}

/**
 * The project has one SiliconFlow account under two variable names: the web
 * app and pdf_extraction/lib/vision_client.py read SILICONFLOW_API_KEY, while
 * the V3 batch scripts read V3_OPENAI_API_KEY. Handwriting OCR must work from
 * either, or a deployment that only set the pipeline variable silently
 * degrades to text-only grading with no error anywhere.
 *
 * These tests never assert on a key's value — only on which variable was
 * consulted — so the sentinels below are deliberately fake.
 */

const VARS = [
  'SILICONFLOW_API_KEY',
  'V3_OPENAI_API_KEY',
  'V3_OPENAI_CHAT_COMPLETIONS_URL',
  'GEMINI_API_KEY',
] as const;

const original = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));

function setEnv(values: Partial<Record<(typeof VARS)[number], string>>) {
  for (const name of VARS) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(() => {
  for (const name of VARS) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test('the canonical variable is used when set', () => {
  setEnv({ SILICONFLOW_API_KEY: 'canonical-sentinel' });
  assert.equal(siliconflowKey(), 'canonical-sentinel');
  assert.equal(sharedVisionProvider(), 'openai-compatible');
});

test('the pipeline variable is accepted as an alias', () => {
  setEnv({ V3_OPENAI_API_KEY: 'pipeline-sentinel' });
  assert.equal(siliconflowKey(), 'pipeline-sentinel');
  assert.equal(sharedVisionProvider(), 'openai-compatible');
});

test('the canonical variable wins when both are set', () => {
  setEnv({ SILICONFLOW_API_KEY: 'canonical-sentinel', V3_OPENAI_API_KEY: 'pipeline-sentinel' });
  assert.equal(siliconflowKey(), 'canonical-sentinel');
});

test('the alias is ignored when the pipeline points at another provider', () => {
  // That key belongs to whoever V3_OPENAI_CHAT_COMPLETIONS_URL names; sending
  // it to api.siliconflow.cn would leak a third party's credential.
  setEnv({
    V3_OPENAI_API_KEY: 'pipeline-sentinel',
    V3_OPENAI_CHAT_COMPLETIONS_URL: 'https://api.openai.com/v1/chat/completions',
  });
  assert.equal(siliconflowKey(), '');
  assert.equal(sharedVisionProvider(), null);
});

test('the alias survives an explicit SiliconFlow endpoint', () => {
  setEnv({
    V3_OPENAI_API_KEY: 'pipeline-sentinel',
    V3_OPENAI_CHAT_COMPLETIONS_URL: 'https://api.siliconflow.cn/v1/chat/completions',
  });
  assert.equal(siliconflowKey(), 'pipeline-sentinel');
});

test('no key at all leaves vision unconfigured', () => {
  setEnv({});
  assert.equal(siliconflowKey(), '');
  assert.equal(sharedVisionProvider(), null);
});
