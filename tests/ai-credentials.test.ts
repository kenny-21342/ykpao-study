import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

/**
 * Tests for bring-your-own-key AI credentials.
 *
 * Two things are pinned here, because both fail silently and expensively:
 *
 *  1. lib/credential-crypto.ts — a student's real, billable API key is stored
 *     in our database. A round-trip that quietly loses authentication, or a
 *     mask that leaks more than four characters, is a security bug that no
 *     other test would catch.
 *  2. The resolution order in lib/ai-credentials.ts — own key, then an
 *     admin-granted share of the owner's key, then off. The regression that
 *     matters is an ungranted account falling through to the owner's key,
 *     which shows up as a bill rather than as a failing request.
 *
 * `resolveFromRow` and `gateText`/`gateVision` are pure by design, so the
 * whole decision table is exercised without a database.
 */

// Must be set before the module is first imported: readKey() caches per raw
// value, but the credential UI's "is this configured" check runs eagerly.
process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const {
  encryptSecret,
  decryptSecret,
  maskSecret,
  isCredentialEncryptionConfigured,
  CredentialCryptoError,
} = await import('../lib/credential-crypto.ts');

const { resolveFromRow, gateText, gateVision, toChatCompletionsUrl, validateBaseUrl } =
  await import('../lib/ai-credentials.ts');

const { resolveOwnTextCredential, probeTextCredential, sanitizeProviderMessage } =
  await import('../lib/ai-key-test.ts');

// ---------------------------------------------------------------------------
// Encryption at rest
// ---------------------------------------------------------------------------

test('a key survives an encrypt/decrypt round trip', () => {
  const secret = 'sk-abcdef0123456789abcdef0123456789';
  const envelope = encryptSecret(secret);
  assert.notEqual(envelope, secret);
  assert.ok(!envelope.includes(secret), 'the plaintext must not appear in the envelope');
  assert.equal(decryptSecret(envelope), secret);
});

test('the envelope is versioned and randomised per call', () => {
  const a = encryptSecret('sk-same-key-twice');
  const b = encryptSecret('sk-same-key-twice');
  assert.notEqual(a, b, 'a fresh IV must make identical secrets encrypt differently');
  for (const envelope of [a, b]) {
    const parts = envelope.split('.');
    assert.equal(parts.length, 4);
    assert.equal(parts[0], 'v1');
  }
});

test('a tampered ciphertext is rejected rather than decrypted to garbage', () => {
  const envelope = encryptSecret('sk-tamper-me');
  const parts = envelope.split('.');
  // Flip a character in the ciphertext segment.
  const ct = parts[3];
  parts[3] = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
  assert.throws(() => decryptSecret(parts.join('.')), CredentialCryptoError);
});

test('a key encrypted under a different encryption key cannot be opened', () => {
  const envelope = encryptSecret('sk-rotated-away');
  const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
  try {
    process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    assert.throws(() => decryptSecret(envelope), CredentialCryptoError);
  } finally {
    process.env.CREDENTIAL_ENCRYPTION_KEY = original;
  }
  // And the original key still works, i.e. the cache did not go stale.
  assert.equal(decryptSecret(envelope), 'sk-rotated-away');
});

test('malformed envelopes are rejected', () => {
  for (const bad of ['', 'not-an-envelope', 'v1.a.b', 'v2.a.b.c']) {
    assert.throws(() => decryptSecret(bad), CredentialCryptoError);
  }
});

test('an encryption key of the wrong length is refused', () => {
  const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
  try {
    process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.from('too short').toString('base64');
    assert.equal(isCredentialEncryptionConfigured(), false);
    assert.throws(() => encryptSecret('sk-nope'), CredentialCryptoError);
  } finally {
    process.env.CREDENTIAL_ENCRYPTION_KEY = original;
  }
});

test('the mask reveals only the last four characters', () => {
  const secret = 'sk-abcdef0123456789wxyz';
  const masked = maskSecret(secret);
  assert.equal(masked, '••••wxyz');
  assert.ok(!masked.includes('abcdef'), 'the mask must not leak the body of the key');
  // Short secrets reveal nothing at all rather than most of themselves.
  assert.equal(maskSecret('abcd'), '••••');
});

// ---------------------------------------------------------------------------
// Endpoint handling
// ---------------------------------------------------------------------------

test('base URLs are normalised to a chat/completions endpoint', () => {
  assert.equal(
    toChatCompletionsUrl('https://api.deepseek.com'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    toChatCompletionsUrl('https://api.deepseek.com/v1'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    toChatCompletionsUrl('https://api.deepseek.com/v1/'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  // Already fully qualified: left alone.
  assert.equal(
    toChatCompletionsUrl('https://api.deepseek.com/v1/chat/completions'),
    'https://api.deepseek.com/v1/chat/completions',
  );
});

test('only https endpoints are accepted', () => {
  assert.ok(validateBaseUrl('https://api.deepseek.com/v1'));
  // http would put the student's bearer token on the wire in clear.
  assert.equal(validateBaseUrl('http://api.deepseek.com/v1'), null);
  assert.equal(validateBaseUrl('https://localhost/v1'), null);
  assert.equal(validateBaseUrl('file:///etc/passwd'), null);
  assert.equal(validateBaseUrl('not a url'), null);
  assert.equal(validateBaseUrl(''), null);
});

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

/** A stored row for a student who saved their own text-and-vision key. */
function ownKeyRow(overrides: Record<string, unknown> = {}) {
  return {
    encryptedApiKey: encryptSecret('sk-student-own-key'),
    keyHint: '••••-key',
    baseUrl: 'https://api.deepseek.com/v1',
    textModel: 'deepseek-chat',
    visionModel: 'Qwen/Qwen3-VL-32B-Instruct',
    sharedKeyAccess: false,
    ...overrides,
  };
}

/** Run a body with the owner's shared server key present in the environment. */
function withSharedKey<T>(fn: () => T): T {
  const before = {
    deepseek: process.env.DEEPSEEK_API_KEY,
    siliconflow: process.env.SILICONFLOW_API_KEY,
  };
  process.env.DEEPSEEK_API_KEY = 'sk-owner-server-key';
  process.env.SILICONFLOW_API_KEY = 'sk-owner-vision-key';
  try {
    return fn();
  } finally {
    if (before.deepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = before.deepseek;
    if (before.siliconflow === undefined) delete process.env.SILICONFLOW_API_KEY;
    else process.env.SILICONFLOW_API_KEY = before.siliconflow;
  }
}

/** Run a body with no shared server key configured at all. */
function withoutSharedKey<T>(fn: () => T): T {
  const before = {
    deepseek: process.env.DEEPSEEK_API_KEY,
    siliconflow: process.env.SILICONFLOW_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
  };
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.SILICONFLOW_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    return fn();
  } finally {
    for (const [name, value] of [
      ['DEEPSEEK_API_KEY', before.deepseek],
      ['SILICONFLOW_API_KEY', before.siliconflow],
      ['GEMINI_API_KEY', before.gemini],
    ] as const) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}

test('a user with their own key uses it, not the owner’s', () => {
  withSharedKey(() => {
    const resolved = resolveFromRow(ownKeyRow());
    assert.equal(resolved.status.source, 'user');
    assert.equal(resolved.text?.source, 'user');
    assert.equal(resolved.text?.apiKey, 'sk-student-own-key');
    assert.equal(resolved.text?.model, 'deepseek-chat');
    assert.equal(
      resolved.text?.endpoint,
      'https://api.deepseek.com/v1/chat/completions',
      'the stored base URL must be normalised before use',
    );
    assert.equal(resolved.vision?.apiKey, 'sk-student-own-key');
    assert.equal(resolved.vision?.provider, 'openai-compatible');
  });
});

test('an account with no row at all gets nothing, even when a shared key exists', () => {
  withSharedKey(() => {
    const resolved = resolveFromRow(null);
    assert.equal(resolved.text, null);
    assert.equal(resolved.vision, null);
    assert.equal(resolved.status.textEnabled, false);

    const gate = gateText(resolved);
    assert.equal(gate.ok, false);
    assert.equal(gate.ok === false && gate.reason, 'no-credentials');
  });
});

test('an ungranted account never falls back to the owner’s key', () => {
  withSharedKey(() => {
    // A row exists (perhaps from a deleted key) but carries no grant.
    const resolved = resolveFromRow({
      encryptedApiKey: null,
      keyHint: null,
      baseUrl: null,
      textModel: null,
      visionModel: null,
      sharedKeyAccess: false,
    });
    assert.equal(resolved.text, null, 'this is the bill-the-owner regression');
    assert.equal(resolved.status.source, null);
    assert.equal(gateText(resolved).ok, false);
  });
});

test('an admin-granted account does fall back to the owner’s key', () => {
  withSharedKey(() => {
    const resolved = resolveFromRow({
      encryptedApiKey: null,
      keyHint: null,
      baseUrl: null,
      textModel: null,
      visionModel: null,
      sharedKeyAccess: true,
    });
    assert.equal(resolved.status.source, 'shared');
    assert.equal(resolved.text?.apiKey, 'sk-owner-server-key');
    assert.equal(resolved.vision?.apiKey, 'sk-owner-vision-key');
    assert.equal(gateText(resolved).ok, true);
    assert.equal(gateVision(resolved).ok, true);
  });
});

test('a grant with no shared key configured resolves to off, not a crash', () => {
  withoutSharedKey(() => {
    const resolved = resolveFromRow({
      encryptedApiKey: null,
      keyHint: null,
      baseUrl: null,
      textModel: null,
      visionModel: null,
      sharedKeyAccess: true,
    });
    assert.equal(resolved.text, null);
    assert.equal(resolved.status.textEnabled, false);
  });
});

// ---------------------------------------------------------------------------
// The text-only case the UI has to explain
// ---------------------------------------------------------------------------

test('a text-only key enables text but reports vision as unavailable', () => {
  withSharedKey(() => {
    const resolved = resolveFromRow(ownKeyRow({ visionModel: null }));

    assert.equal(resolved.status.textEnabled, true);
    assert.equal(resolved.status.visionEnabled, false);
    assert.equal(resolved.vision, null);
    assert.equal(gateText(resolved).ok, true, 'text features must keep working');

    const gate = gateVision(resolved);
    assert.equal(gate.ok, false);
    assert.equal(gate.ok === false && gate.reason, 'no-vision-model');
    // The message must name what broke and what still works, or students
    // assume the whole app is broken.
    const message = gate.ok === false ? gate.error : '';
    assert.match(message, /OCR/i);
    assert.match(message, /deepseek-chat/);

    // Critically: a user with their own text-only key must NOT silently
    // borrow the owner's vision key.
    assert.equal(gate.ok, false);
  });
});

test('a stored key that cannot be decrypted is a distinct, recoverable state', () => {
  withSharedKey(() => {
    const resolved = resolveFromRow(
      ownKeyRow({ encryptedApiKey: 'v1.AAAA.BBBB.CCCC' }),
    );
    assert.equal(resolved.status.hasOwnKey, true);
    assert.equal(resolved.status.keyUndecryptable, true);
    assert.equal(resolved.text, null, 'a junk key must never be sent to a provider');

    const gate = gateText(resolved);
    assert.equal(gate.ok, false);
    assert.equal(gate.ok === false && gate.reason, 'key-undecryptable');
  });
});

test('an incomplete own-key row does not half-enable AI', () => {
  withoutSharedKey(() => {
    // Key saved but no model named: not usable, and not a shared fallback.
    const resolved = resolveFromRow(ownKeyRow({ textModel: null }));
    assert.equal(resolved.text, null);
    assert.equal(resolved.status.textEnabled, false);
  });
});

// ---------------------------------------------------------------------------
// Nothing user-facing may carry the secret
// ---------------------------------------------------------------------------

test('the status object never contains the plaintext key', () => {
  withSharedKey(() => {
    const { status } = resolveFromRow(ownKeyRow());
    const serialised = JSON.stringify(status);
    assert.ok(
      !serialised.includes('sk-student-own-key'),
      'the status object is returned to the client and must not carry the secret',
    );
  });
});

// ---------------------------------------------------------------------------
// "Test my key" — the one path that must not fall back to anything
// ---------------------------------------------------------------------------

/**
 * The regression these guard against is a false pass. A student whose key is
 * wrong, but who happens to hold an admin grant, must see the test FAIL — if
 * the probe quietly used the owner's key instead, the button would go green
 * and the student would keep hitting the same broken key in every feature.
 */

// The dangerous shape: granted the owner's key, but nothing of their own.
// Declared as a variable rather than inline because `OwnKeyRow` does not
// contain `sharedKeyAccess` at all — passing it inline is a type error, which
// is itself part of the no-fallback guarantee.
const grantedWithNoOwnKey = {
  encryptedApiKey: null,
  baseUrl: null,
  textModel: null,
  sharedKeyAccess: true,
};

test('the key test refuses an account that has no key of its own', () => {
  withSharedKey(() => {
    for (const row of [
      null,
      { encryptedApiKey: null, baseUrl: null, textModel: null },
      grantedWithNoOwnKey,
    ]) {
      const resolved = resolveOwnTextCredential(row);
      assert.equal(resolved.ok, false, 'there is nothing of the user\u2019s own to test');
      assert.equal(resolved.ok === false && resolved.reason, 'no-own-key');
    }
  });
});

test('a grant cannot make the key test resolve the owner\u2019s key', () => {
  withSharedKey(() => {
    const granted = {
      encryptedApiKey: null,
      keyHint: null,
      baseUrl: null,
      textModel: null,
      visionModel: null,
      sharedKeyAccess: true,
    };

    // The feature resolver DOES fall back — proving the shared key is really
    // present in the environment for this assertion to be meaningful.
    assert.equal(resolveFromRow(granted).text?.apiKey, 'sk-owner-server-key');

    // The key test, given the same row, resolves nothing.
    const resolved = resolveOwnTextCredential(granted);
    assert.equal(resolved.ok, false);
    assert.equal(
      JSON.stringify(resolved).includes('sk-owner-server-key'),
      false,
      'the owner\u2019s key must not appear anywhere in the refusal',
    );
  });
});

test('the key test uses the user\u2019s own key even when a shared key exists', () => {
  withSharedKey(() => {
    // Own key AND a grant: the own key must win, so the test is honest.
    const bothRow = { ...ownKeyRow(), sharedKeyAccess: true };
    const resolved = resolveOwnTextCredential(bothRow);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.ok === true && resolved.credential.apiKey, 'sk-student-own-key');
    assert.equal(resolved.ok === true && resolved.credential.source, 'user');
    assert.equal(
      resolved.ok === true && resolved.credential.endpoint,
      'https://api.deepseek.com/v1/chat/completions',
    );
  });
});

test('an incomplete or unreadable own key is refused rather than tested', () => {
  withSharedKey(() => {
    const incomplete = resolveOwnTextCredential(ownKeyRow({ textModel: null }));
    assert.equal(incomplete.ok === false && incomplete.reason, 'incomplete');

    const junk = resolveOwnTextCredential(ownKeyRow({ encryptedApiKey: 'v1.AAAA.BBBB.CCCC' }));
    assert.equal(junk.ok === false && junk.reason, 'key-undecryptable');
  });
});

// --- the probe itself, against a stubbed fetch (never a real provider) ------

const TEST_CREDENTIAL = {
  source: 'user' as const,
  apiKey: 'sk-probe-key-0123456789abcdef',
  endpoint: 'https://api.example.com/v1/chat/completions',
  model: 'test-model',
};

function stubFetch(
  handler: (url: string, init: RequestInit) => { status: number; body: string },
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: unknown, init: unknown) => {
    const request = { url: String(url), init: (init ?? {}) as RequestInit };
    calls.push(request);
    const { status, body } = handler(request.url, request.init);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('a successful probe is one minimal completion to the user\u2019s endpoint', async () => {
  const { impl, calls } = stubFetch(() => ({
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: 'p' } }] }),
  }));

  const result = await probeTextCredential(TEST_CREDENTIAL, { fetchImpl: impl });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);

  assert.equal(calls.length, 1, 'exactly one provider call, and no retries');
  assert.equal(calls[0].url, TEST_CREDENTIAL.endpoint);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TEST_CREDENTIAL.apiKey}`);
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.max_tokens, 1, 'the probe must stay as cheap as possible');
  assert.equal(body.model, 'test-model');
});

test('a rejected key reports the provider\u2019s reason and fails', async () => {
  const { impl } = stubFetch(() => ({
    status: 401,
    body: JSON.stringify({ error: { message: 'Authentication Fails, Your api key is invalid' } }),
  }));

  const result = await probeTextCredential(TEST_CREDENTIAL, { fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.message, /rejected the key/i);
  assert.match(result.message, /Authentication Fails/);
});

test('a provider error that echoes the key back has it redacted', async () => {
  const { impl } = stubFetch(() => ({
    status: 400,
    body: JSON.stringify({
      error: { message: `Bad request for Bearer ${TEST_CREDENTIAL.apiKey} on model test-model` },
    }),
  }));

  const result = await probeTextCredential(TEST_CREDENTIAL, { fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.ok(
    !result.message.includes(TEST_CREDENTIAL.apiKey),
    'the decrypted key must never be echoed back to the client',
  );
  assert.match(result.message, /\[redacted\]/);
});

test('the sanitiser removes fragments of the key, not just the whole thing', () => {
  const key = 'sk-abcdefgh-middle-12345678';
  const cleaned = sanitizeProviderMessage(
    `invalid key sk-abcdef\u0000gh... suffix 12345678 here`,
    key,
  );
  assert.ok(!cleaned.includes('12345678'), 'the tail of the key must not survive');
  assert.ok(!/[\u0000-\u001f]/.test(cleaned), 'control characters are stripped');
});

test('a 200 that is not an OpenAI-compatible completion is not a pass', async () => {
  const { impl } = stubFetch(() => ({ status: 200, body: '<html>captive portal</html>' }));
  const result = await probeTextCredential(TEST_CREDENTIAL, { fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.match(result.message, /OpenAI-compatible/i);
});

test('an unreachable endpoint fails with a fixed message, not the raw error', async () => {
  const impl = (async () => {
    throw new Error('getaddrinfo ENOTFOUND api.example.com secret-internal-detail');
  }) as unknown as typeof fetch;

  const result = await probeTextCredential(TEST_CREDENTIAL, { fetchImpl: impl });
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.ok(!result.message.includes('secret-internal-detail'));
  assert.match(result.message, /Could not reach your endpoint/);
});
