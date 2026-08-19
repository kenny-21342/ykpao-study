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
