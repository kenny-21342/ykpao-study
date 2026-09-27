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

// ---------------------------------------------------------------------------
// SSRF: "test my key" makes the server fetch a user-supplied URL, so the host
// is checked before the endpoint is ever stored.
// ---------------------------------------------------------------------------

test('validateBaseUrl rejects loopback, private ranges and cloud metadata', () => {
  const blocked = [
    'https://localhost/v1',
    'https://LOCALHOST/v1',
    'https://api.localhost/v1',
    'https://box.internal/v1',
    'https://printer.local/v1',
    'https://127.0.0.1/v1',
    'https://127.1.2.3/v1',
    'https://0.0.0.0/v1',
    'https://10.0.0.5/v1',
    'https://172.16.0.1/v1',
    'https://172.31.255.254/v1',
    'https://192.168.1.1/v1',
    'https://100.64.0.1/v1',
    // The one that matters most: cloud instance metadata.
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/v1',
    'https://[fd00::1]/v1',
    'https://[fe80::1]/v1',
    'https://[::ffff:127.0.0.1]/v1',
    // Exotic IPv4 spellings the URL parser normalises to 127.0.0.1.
    'https://2130706433/v1',
    'https://0177.0.0.1/v1',
  ];
  for (const url of blocked) {
    assert.equal(validateBaseUrl(url), null, `should reject ${url}`);
  }
});

test('validateBaseUrl still accepts real provider endpoints', () => {
  for (const url of [
    'https://api.deepseek.com/v1',
    'https://api.siliconflow.cn/v1/chat/completions',
    'https://api.openai.com/v1',
    // 172.32 is outside the private block; 192.169 likewise.
    'https://172.32.0.1/v1',
    'https://192.169.0.1/v1',
  ]) {
    assert.ok(validateBaseUrl(url), `should accept ${url}`);
  }
});

test('validateBaseUrl still rejects non-https', () => {
  assert.equal(validateBaseUrl('http://api.deepseek.com/v1'), null);
  assert.equal(validateBaseUrl('file:///etc/passwd'), null);
});

/**
 * Every client of /api/account/ai-credentials must unwrap the envelope.
 *
 * The GET handler answers `{ credentials: publicView(status) }`, not the bare
 * view. `AiKeyPrompt` read `data.textEnabled` off the envelope, which is
 * `undefined` — and since its check was the deliberately conservative
 * `=== false` ("a failed lookup is not evidence the key is missing"), the card
 * never appeared for anybody and never logged anything either. It failed
 * closed and silently, which is the worst combination: a feature that is
 * merely absent looks identical to a feature that was never reached.
 *
 * Caught only when a real account was created through signup and the card that
 * was supposed to greet it did not.
 */
test('clients of the ai-credentials route read through .credentials', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');

  const files: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  }
  await walk(join(root, 'app'));

  // The handler itself, and the route file, are not clients of it.
  const ROUTE = 'app/api/account/ai-credentials/route.ts';

  const offenders: string[] = [];
  for (const file of files) {
    const relative = file.slice(root.length + 1);
    if (relative === ROUTE) continue;

    const src = await readFile(file, 'utf8');
    if (!src.includes("'/api/account/ai-credentials'")) continue;
    // A GET client must name the envelope. A file that only PUTs or DELETEs
    // reads no body shape and is exempt.
    const readsBody = /\.json\(\)/.test(src);
    if (readsBody && !/\.credentials\b/.test(src)) offenders.push(relative);
  }

  assert.deepEqual(
    offenders,
    [],
    `these read /api/account/ai-credentials without unwrapping .credentials:\n${offenders.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// Open access to the shared key (SHARED_AI_OPEN_TO_ALL)
// ---------------------------------------------------------------------------

/**
 * From 27 Sep 2026 the whole year group is meant to reach the tutor. The two
 * tests above still stand unchanged, and that is the point: with the switch
 * off, an ungranted account still gets nothing. These pin the other half.
 */
const { sharedModelIsFree, isSharedAiOpenToAll, sharedTextCredential } =
  await import('../lib/ai-credentials.ts');
const { isFreeModel, FREE_MODELS } = await import('../lib/ai-pricing.ts');

function withOpenAccess<T>(model: string, fn: () => T): T {
  const before = {
    open: process.env.SHARED_AI_OPEN_TO_ALL,
    key: process.env.SHARED_AI_API_KEY,
    base: process.env.SHARED_AI_BASE_URL,
    model: process.env.SHARED_AI_MODEL,
    interactive: process.env.AI_INTERACTIVE_MODEL,
  };
  process.env.SHARED_AI_OPEN_TO_ALL = 'on';
  process.env.SHARED_AI_API_KEY = 'sk-owner-server-key';
  process.env.SHARED_AI_BASE_URL = 'https://runanytime.hxi.me/v1';
  process.env.SHARED_AI_MODEL = model;
  delete process.env.AI_INTERACTIVE_MODEL;
  try {
    return fn();
  } finally {
    for (const [name, value] of [
      ['SHARED_AI_OPEN_TO_ALL', before.open],
      ['SHARED_AI_API_KEY', before.key],
      ['SHARED_AI_BASE_URL', before.base],
      ['SHARED_AI_MODEL', before.model],
      ['AI_INTERACTIVE_MODEL', before.interactive],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('with open access on, an account with no row at all reaches the tutor', () => {
  withOpenAccess('big-pickle', () => {
    const resolved = resolveFromRow(null);
    assert.equal(resolved.status.textEnabled, true);
    assert.equal(resolved.status.source, 'shared');
    assert.equal(resolved.text?.model, 'big-pickle');
    assert.equal(gateText(resolved).ok, true);
  });
});

test('with open access on, an ungranted row still reaches the tutor', () => {
  withOpenAccess('big-pickle', () => {
    const resolved = resolveFromRow({
      encryptedApiKey: null,
      keyHint: null,
      baseUrl: null,
      textModel: null,
      visionModel: null,
      sharedKeyAccess: false,
    });
    assert.equal(resolved.status.source, 'shared');
    assert.equal(gateText(resolved).ok, true);
  });
});

test('open access never overrides a student’s own key', () => {
  withOpenAccess('big-pickle', () => {
    const resolved = resolveFromRow(ownKeyRow());
    assert.equal(resolved.status.source, 'user', 'their key, their model, their bill');
    assert.notEqual(resolved.text?.model, 'big-pickle');
  });
});

test('the switch is off unless explicitly set', () => {
  const before = process.env.SHARED_AI_OPEN_TO_ALL;
  try {
    for (const value of [undefined, '', 'off', 'false', '0', 'no', 'yes-please']) {
      if (value === undefined) delete process.env.SHARED_AI_OPEN_TO_ALL;
      else process.env.SHARED_AI_OPEN_TO_ALL = value;
      assert.equal(isSharedAiOpenToAll(), false, `"${value}" must not open access`);
    }
    for (const value of ['on', 'true', '1', 'ON', ' True ']) {
      process.env.SHARED_AI_OPEN_TO_ALL = value;
      assert.equal(isSharedAiOpenToAll(), true, `"${value}" must open access`);
    }
  } finally {
    if (before === undefined) delete process.env.SHARED_AI_OPEN_TO_ALL;
    else process.env.SHARED_AI_OPEN_TO_ALL = before;
  }
});

test('a bare base URL is normalised to a chat-completions endpoint', () => {
  withOpenAccess('big-pickle', () => {
    assert.equal(
      sharedTextCredential()?.endpoint,
      'https://runanytime.hxi.me/v1/chat/completions',
    );
  });
});

test('FREE_MODELS is empty, and that is what keeps the spend cap on', () => {
  // It held OpenCode Zen's free tier until 27 Sep 2026. That never worked:
  // that provider permits its free models only inside its own client. The key
  // now points at a gateway where every model bills, so the list must stay
  // empty — an entry here switches the per-user monthly cap off for that
  // model, and with open access the cap is the only bound on what a whole year
  // group can spend.
  assert.deepEqual([...FREE_MODELS], []);
  for (const model of ['deepseek-chat', 'gpt-4o', 'claude-sonnet-4-6', 'big-pickle', '']) {
    assert.equal(isFreeModel(model), false, model);
  }
  withOpenAccess('gpt-4o-mini', () => {
    assert.equal(sharedModelIsFree(), false);
  });
});

test('both the primary and the interactive model must be free to skip the cap', () => {
  // `forInteractive` swaps the model on exactly the calls a student waits on,
  // so a free primary with a billing interactive model must not skip the cap.
  // Exercised against a stand-in list because nothing is free today; the rule
  // has to survive the next provider, which is when it would matter again.
  const freeish = (model: string) => ['free-a', 'free-b'].includes(model);
  const bothFree = (primary: string, interactive?: string) =>
    freeish(primary) && (!interactive || freeish(interactive));
  assert.equal(bothFree('free-a'), true);
  assert.equal(bothFree('free-a', 'free-b'), true);
  assert.equal(bothFree('free-a', 'gpt-4o'), false, 'the swapped-in model bills');
  assert.equal(bothFree('gpt-4o', 'free-a'), false);
});

// ---------------------------------------------------------------------------
// The tutor's model catalogue
// ---------------------------------------------------------------------------

/**
 * The shared key points at a New API gateway whose models come and go: of the
 * twenty it carries, thirteen were down when this was written. The catalogue
 * is therefore read from the operator's public status page rather than
 * hardcoded, and these pin the two things that would fail quietly — parsing
 * someone else's payload shape, and resolving a model that cannot answer.
 */
const { watchedFrom, mergeCatalogue, resolveSharedModel, modelLabel, vendorFor, FALLBACK_MODELS } =
  await import('../lib/shared-models.ts');

/** A trimmed copy of the real status-page payloads, including the probe group. */
const PAGE = {
  publicGroupList: [
    { name: '北京检测节点', monitorList: [{ id: 6, name: 'yang-api' }] },
    { name: 'OpenAI', monitorList: [{ id: 68, name: 'gpt-6-astra' }, { id: 40, name: 'gpt-4o-mini' }, { id: 70, name: 'openai/gpt-oss-120b' }] },
    { name: 'Anthropic', monitorList: [{ id: 71, name: 'claude-sonnet-4-6' }] },
    { name: 'Grok', monitorList: [{ id: 80, name: 'grok-4.6' }] },
  ],
};
const BEATS = {
  heartbeatList: {
    '6': [{ status: 1 }],
    '68': [{ status: 0 }, { status: 1 }],
    '40': [{ status: 1 }],
    '70': [{ status: 0 }],
    '71': [{ status: 1 }],
    '80': [{ status: 1 }, { status: 0 }],
  },
};
/** What `/v1/models` actually returns for this key: OpenAI channels only. */
const GATEWAY_IDS = ['gpt-4', 'gpt-4o-mini', 'gpt-6-astra', 'openai/gpt-oss-120b'];

const watched = () => watchedFrom(PAGE, BEATS);
const catalogue = () => mergeCatalogue(GATEWAY_IDS, watched());

test('the gateway’s own health monitor is not offered as a model', () => {
  // `yang-api` is a check on the gateway's reachability. Offering it would
  // send a student's question to something that is not a model at all.
  assert.equal(watched().has('yang-api'), false);
});

test('a model the status page shows UP is still hidden if the key cannot call it', () => {
  // The bug this pairing exists to prevent. `claude-sonnet-4-6` is watched and
  // up, and answers this key with 503 model_not_found, because the key's token
  // group carries only OpenAI channels. Verified against the live gateway on
  // 27 Sep 2026: /v1/models returned 7 ids where the page watched 20.
  const models = catalogue();
  assert.equal(models.find((m) => m.id === 'claude-sonnet-4-6'), undefined);
  assert.equal(models.find((m) => m.id === 'grok-4.6'), undefined);
  assert.equal(watched().get('claude-sonnet-4-6')?.up, true, 'the page really does show it up');
});

test('a model the gateway offers but nobody watches is treated as available', () => {
  // The page's silence is absence of evidence. The gateway listing a model is
  // better evidence than a monitor that does not exist.
  const gpt4 = catalogue().find((m) => m.id === 'gpt-4');
  assert.equal(gpt4?.up, true);
  assert.equal(gpt4?.vendor, 'OpenAI', 'an unwatched model is still filed by family');
});

test('availability comes from the last heartbeat, not any heartbeat', () => {
  const byId = Object.fromEntries(catalogue().map((m) => [m.id, m]));
  // Recovered: failed, then succeeded.
  assert.equal(byId['gpt-6-astra'].up, true);
  // Down now: succeeded, then failed. Reading any beat would call it up.
  assert.equal(byId['openai/gpt-oss-120b'].up, false);
});

test('a model with no heartbeats at all is treated as down', () => {
  const only = mergeCatalogue(['gpt-4o-mini'], watchedFrom(PAGE, { heartbeatList: {} }));
  assert.equal(only[0].up, false, 'watched but never beating is not the same as unwatched');
});

test('a malformed status page yields an empty overlay rather than throwing', () => {
  for (const page of [{}, { publicGroupList: [] }, { publicGroupList: [{ monitorList: [] }] }]) {
    assert.equal(watchedFrom(page, {}).size, 0);
  }
  // And with no overlay, every gateway model stays usable.
  assert.deepEqual(mergeCatalogue(GATEWAY_IDS, new Map()).map((m) => m.up), [true, true, true, true]);
});

test('the vendor prefix is dropped for display but never from the id', () => {
  const oss = catalogue().find((m) => m.id === 'openai/gpt-oss-120b')!;
  assert.equal(oss.label, 'gpt-oss-120b');
  assert.equal(oss.id, 'openai/gpt-oss-120b', 'the id is what is sent to the provider');
  assert.equal(modelLabel('gpt-4o'), 'gpt-4o', 'an unprefixed id is left alone');
});

test('a student’s choice is honoured when it is up', () => {
  assert.equal(resolveSharedModel(catalogue(), 'gpt-6-astra', 'gpt-4o-mini'), 'gpt-6-astra');
});

test('a choice that is down falls through instead of failing the message', () => {
  assert.equal(resolveSharedModel(catalogue(), 'openai/gpt-oss-120b', 'gpt-4o-mini'), 'gpt-4o-mini');
});

test('a model outside the catalogue is refused, whatever it names', () => {
  // This is the check that runs on an attacker-controlled body. Accepting an
  // arbitrary id would let a request name the most expensive model the gateway
  // sells and spend the operator's credit on it. `claude-sonnet-4-6` is here
  // deliberately: it is real, and watched, and still not ours to call.
  const models = catalogue();
  for (const bad of ['claude-sonnet-4-6', 'gpt-7', '', null, undefined, 'GPT-4O-MINI']) {
    assert.equal(
      resolveSharedModel(models, bad, 'gpt-4o-mini'),
      'gpt-4o-mini',
      `"${bad}" must not be used as given`,
    );
  }
});

test('when the configured model is also down, anything up is used', () => {
  const models = mergeCatalogue(GATEWAY_IDS, watched());
  const picked = resolveSharedModel(models, 'openai/gpt-oss-120b', 'openai/gpt-oss-120b');
  assert.notEqual(picked, 'openai/gpt-oss-120b');
  assert.equal(models.find((m) => m.id === picked)?.up, true);
});

test('when nothing is up, the configured model is sent anyway', () => {
  // The status page can be wrong or stale. A real error from the gateway is
  // more useful to a student than a refusal invented here.
  const allDown = mergeCatalogue(GATEWAY_IDS, watchedFrom(PAGE, { heartbeatList: {} }))
    .map((m) => ({ ...m, up: false }));
  assert.equal(resolveSharedModel(allDown, 'gpt-6-astra', 'gpt-4o-mini'), 'gpt-4o-mini');
  assert.equal(resolveSharedModel([], 'gpt-6-astra', 'gpt-4o-mini'), 'gpt-4o-mini');
});

test('the fallback holds the fastest model, since it is a guarantee not a menu', () => {
  // Measured against the live gateway 27 Sep 2026: gpt-4o-mini 2.1s,
  // gpt-6-astra 29s, for the same three-token reply.
  assert.deepEqual(FALLBACK_MODELS.map((m) => m.id), ['gpt-4o-mini']);
  assert.ok(FALLBACK_MODELS.every((m) => m.up));
});

test('no shared model is treated as free, so the monthly cap still applies', () => {
  // Every model on this gateway draws down the operator's credit. With open
  // access the cap is the only bound on what a year group can spend, so an
  // entry creeping into FREE_MODELS would switch that protection off silently.
  for (const m of [...catalogue(), ...FALLBACK_MODELS]) {
    assert.equal(isFreeModel(m.id), false, m.id);
  }
  withOpenAccess('gpt-4o-mini', () => {
    assert.equal(sharedModelIsFree(), false, 'the cap must not be skipped on a paid gateway');
  });
});

test('no API route assigns a client-supplied model straight to a credential', async () => {
  /**
   * The tests above prove `resolveSharedModel` refuses an unknown id. They do
   * not prove any route calls it — when this was first written against the
   * previous provider, deleting the guard from `rag-chat/route.ts` left every
   * one of them green. That is the kind of hole that surfaces as someone
   * else's bill.
   *
   * Two rules, both read off the source. Not a dataflow proof and not claimed
   * as one: it is a guardrail against the regression that actually happened,
   * which is a body field being dropped into the credential directly.
   */
  const { readFile, readdir } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.resolve(import.meta.dirname, '..', 'app', 'api');

  async function* walk(dir: string): AsyncGenerator<string> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (entry.name.endsWith('.ts')) yield full;
    }
  }

  const assigned: string[] = [];
  const unresolved: string[] = [];
  let checked = 0;

  for await (const file of walk(root)) {
    const src = await readFile(file, 'utf8');
    const rel = path.relative(root, file);
    let readsBodyModel = false;

    for (const [index, line] of src.split('\n').entries()) {
      // Comments discuss `parsed.model` by name — including the one explaining
      // why it is never used raw — so only code counts.
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (!/\b(?:parsed|body|payload)\.model\b/.test(line)) continue;
      readsBodyModel = true;
      checked += 1;
      // 1. It must never be the value of a `model:` property. That is the
      //    shape that reaches a provider call.
      if (/\bmodel:\s*(?:parsed|body|payload)\.model\b/.test(line)) {
        assigned.push(`${rel}:${index + 1}: ${trimmed}`);
      }
    }

    // 2. A route that reads a model off the body at all must import and use
    //    the resolver somewhere in the same file.
    if (readsBodyModel && !/resolveSharedModel\s*\(/.test(src)) {
      unresolved.push(rel);
    }
  }

  assert.ok(checked > 0, 'the scan found no model-bearing routes, so it proves nothing');
  assert.deepEqual(assigned, [], `client-supplied model assigned directly:\n${assigned.join('\n')}`);
  assert.deepEqual(unresolved, [], `reads a model off the body but never resolves it:\n${unresolved.join('\n')}`);
});

test('a configured model the gateway does not carry is corrected, not sent', () => {
  /**
   * The regression this pins actually shipped for a few minutes. `.env` had no
   * SHARED_AI_MODEL, so `sharedTextCredential` fell through to the legacy
   * DEEPSEEK_MODEL and produced `deepseek-chat` — a model this gateway does
   * not carry. An optimisation that skipped the catalogue lookup when the
   * student had not picked anything meant nothing corrected it, and every
   * tutor message would have come back 503.
   *
   * So the resolver has to hold even when the *configuration* is wrong, not
   * only when the request is.
   */
  const models = mergeCatalogue(['gpt-4o-mini', 'gpt-6-astra'], new Map());
  assert.equal(resolveSharedModel(models, undefined, 'deepseek-chat'), 'gpt-4o-mini');
  assert.equal(resolveSharedModel(models, null, 'gpt-4'), 'gpt-4o-mini');
  // And the fallback list alone is enough to rescue it, which is what happens
  // when the catalogue lookup times out on a cold instance.
  assert.equal(
    resolveSharedModel([...FALLBACK_MODELS], undefined, 'deepseek-chat'),
    'gpt-4o-mini',
  );
});

test('every model the gateway actually serves is filed under a real vendor', () => {
  /**
   * The full list `/v1/models` returned on production, 27 Sep 2026. Recorded
   * because grouping used to come from the status page's own group names,
   * which produced a picker a student would find incoherent: `z-ai/glm-5.2`
   * under "GLM" while `z-ai/glm-5.3-flash` was unwatched and fell to "Other",
   * and all six Gemini models under "Other" as well — eight of twenty-eight.
   *
   * Deriving from the id fixes that, and this pins it against the real
   * line-up so a future model that lands outside the table is noticed here
   * rather than by a student.
   */
  const LIVE_IDS = [
    'claude-sonnet-4-6', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro',
    'z-ai/glm-5.2', 'z-ai/glm-5.3', 'google/gemma-4-31b-it', 'grok-4.6',
    'moonshotai/kimi-k3', 'minimax/minimax-m2.5', 'minimax/minimax-m2.7',
    'minimax/minimax-m3', 'gpt-4o', 'gpt-4o-mini', 'gpt-5.5', 'gpt-5.6-sol',
    'gpt-6-astra', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b',
    'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools',
    'gemini-3.5-flash', 'gpt-4', 'gpt-4-32k', 'grok-4.7', 'z-ai/glm-5.3-flash',
  ];
  const unfiled = LIVE_IDS.filter((id) => vendorFor(id) === 'Other');
  assert.deepEqual(unfiled, [], `not filed under a vendor:\n${unfiled.join('\n')}`);

  // The two that used to disagree now agree.
  assert.equal(vendorFor('z-ai/glm-5.2'), vendorFor('z-ai/glm-5.3-flash'));
  assert.equal(vendorFor('grok-4.6'), vendorFor('grok-4.7'));
  assert.equal(vendorFor('gpt-4o'), vendorFor('openai/gpt-oss-120b'));

  // And an id from nowhere is still called "Other" rather than guessed at.
  assert.equal(vendorFor('something-entirely-new'), 'Other');
});

test('the vendor label never changes the id sent to the provider', () => {
  const models = mergeCatalogue(['z-ai/glm-5.3-flash', 'gemini-3.5-flash'], new Map());
  assert.deepEqual(models.map((m) => m.id), ['gemini-3.5-flash', 'z-ai/glm-5.3-flash']);
  assert.deepEqual(models.map((m) => m.vendor), ['Google', 'Z.ai']);
  assert.deepEqual(models.map((m) => m.label), ['gemini-3.5-flash', 'glm-5.3-flash']);
});

test('the picker’s label must follow the same three steps as the server', () => {
  /**
   * Pinned because the two drifted and it was visible to the user: the header
   * read `gemini-2.5-flash` while every message was answered by the configured
   * `gpt-4o-mini`. The client had skipped the middle step — the configured
   * model — and gone straight to "the first one that is up", which the
   * vendor-sorted catalogue makes Google.
   *
   * This exercises the server's resolver against the cases the label has to
   * agree with; `TutorModelPicker` mirrors these branches in the same order.
   */
  const models = mergeCatalogue(
    ['gemini-2.5-flash', 'gpt-4o-mini', 'gpt-6-astra'],
    new Map([['gpt-6-astra', { up: false }]]),
  );
  // Sorted by vendor, Google comes first — so "first up" is NOT the answer.
  assert.equal(models[0].id, 'gemini-2.5-flash');

  // No pick: the configured model, not the first available one.
  assert.equal(resolveSharedModel(models, null, 'gpt-4o-mini'), 'gpt-4o-mini');
  // A pick that is up wins over the configured model.
  assert.equal(resolveSharedModel(models, 'gemini-2.5-flash', 'gpt-4o-mini'), 'gemini-2.5-flash');
  // A pick that is down falls to the configured model, still not the first up.
  assert.equal(resolveSharedModel(models, 'gpt-6-astra', 'gpt-4o-mini'), 'gpt-4o-mini');
  // Only when the configured model is unusable does "anything up" apply.
  assert.equal(resolveSharedModel(models, 'gpt-6-astra', 'gpt-6-astra'), 'gemini-2.5-flash');
});
