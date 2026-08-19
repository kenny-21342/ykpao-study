// Relative, extension-bearing imports (the convention lib/ai-credentials.ts
// already uses) so this module is loadable by the plain-node test runner as
// well as by Next — the whole point of this file is that its rules are
// testable without a database or a paid provider call.
import { decryptSecret } from './credential-crypto.ts';
import { toChatCompletionsUrl, type CredentialRow, type TextCredential } from './ai-credentials.ts';

/**
 * "Test my key" — the one AI path that must NOT fall back to anything.
 *
 * Everywhere else in the codebase, `resolveAiCredentials` deliberately falls
 * back from the student's own key to an admin-granted share of the owner's
 * server key. That is right for features and catastrophic here: a student with
 * a typo'd key who also holds a grant would watch this button go green, then
 * hit the same broken key the moment the grant is revoked. Worse, a student
 * with no key at all could use this button to confirm the owner's key works.
 *
 * So this module resolves the credential itself, from the stored row only, and
 * has no access to `sharedTextCredential()` or to any environment variable
 * holding a provider key. There is exactly one way to obtain a credential from
 * here — `resolveOwnTextCredential` — and it reads `encryptedApiKey`,
 * `baseUrl` and `textModel` and nothing else.
 */

/**
 * Deliberately narrower than `CredentialRow`: the three columns that describe
 * the user's own key, and nothing else. `sharedKeyAccess` is not in this type,
 * so no code path here can branch on it even by accident.
 */
export type OwnKeyRow = Pick<CredentialRow, 'encryptedApiKey' | 'baseUrl' | 'textModel'>;

export type OwnKeyResolution =
  | { ok: true; credential: TextCredential }
  | { ok: false; reason: 'no-own-key' | 'incomplete' | 'key-undecryptable'; error: string };

export const NO_OWN_KEY_MESSAGE =
  'There is no API key saved on this account to test. Enter your API key, endpoint and ' +
  'text model above and save them first.';

export const INCOMPLETE_MESSAGE =
  'Your saved settings are incomplete — an API endpoint and a text model are both needed ' +
  'before a key can be tested.';

export const UNDECRYPTABLE_MESSAGE =
  'Your saved API key could not be read (the server’s encryption key has changed). ' +
  'Enter your API key again and save, then test it.';

/**
 * The user's OWN text credential, or a refusal. Never returns a shared/platform
 * credential — it cannot: nothing here reads `process.env` or `sharedKeyAccess`.
 */
export function resolveOwnTextCredential(row: OwnKeyRow | null): OwnKeyResolution {
  if (!row || !row.encryptedApiKey) {
    return { ok: false, reason: 'no-own-key', error: NO_OWN_KEY_MESSAGE };
  }
  if (!row.baseUrl || !row.textModel) {
    return { ok: false, reason: 'incomplete', error: INCOMPLETE_MESSAGE };
  }

  let apiKey: string;
  try {
    apiKey = decryptSecret(row.encryptedApiKey);
  } catch {
    // Deliberately does not carry the crypto error through: it says nothing the
    // student can act on and is the sort of detail that ends up in a log sink.
    return { ok: false, reason: 'key-undecryptable', error: UNDECRYPTABLE_MESSAGE };
  }

  return {
    ok: true,
    // `source: 'user'` is a statement of fact here, not a choice — this branch
    // is the only one that exists.
    credential: {
      source: 'user',
      apiKey,
      endpoint: toChatCompletionsUrl(row.baseUrl),
      model: row.textModel,
    },
  };
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

export type ProbeResult = {
  ok: boolean;
  /** HTTP status from the provider, when one was received. */
  status: number | null;
  /** Sanitised, never containing the key. Safe to show a student. */
  message: string;
};

/** Longest provider message ever passed on. Anything longer is a page, not an error. */
const MAX_PROVIDER_MESSAGE = 300;

/** One probe should be fast; a stalled endpoint is itself a useful answer. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Strip anything unsafe or useless out of a provider's error text.
 *
 * Providers echo the request back in error bodies with some regularity, so the
 * key is redacted explicitly rather than trusted not to be there. Control
 * characters are collapsed because this string is rendered as text and logged.
 */
export function sanitizeProviderMessage(raw: string, apiKey: string): string {
  let text = (raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ');
  const key = (apiKey ?? '').trim();
  if (key.length >= 8) {
    text = text.split(key).join('[redacted]');
    // Providers commonly print a partially-masked key; redact the distinctive
    // head and tail too so no usable fragment survives.
    text = text.split(key.slice(0, 8)).join('[redacted]');
    const tail = key.slice(-8);
    if (tail.length === 8) text = text.split(tail).join('[redacted]');
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > MAX_PROVIDER_MESSAGE
    ? `${text.slice(0, MAX_PROVIDER_MESSAGE)}…`
    : text;
}

/** Dig the human-readable part out of whatever shape the provider returned. */
export function extractProviderMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return message;
    }
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.detail === 'string') return parsed.detail;
  } catch {
    // Not JSON — an HTML error page from a proxy, most likely.
  }
  return body;
}

function explainStatus(status: number, provider: string): string {
  const suffix = provider ? ` Provider said: ${provider}` : '';
  if (status === 401 || status === 403) {
    return `Your provider rejected the key (HTTP ${status}). Check that the key is correct, still active, and belongs to this endpoint.${suffix}`;
  }
  if (status === 404) {
    return `The endpoint returned 404. Usually the API endpoint or the model name is wrong.${suffix}`;
  }
  if (status === 429) {
    return `Your provider is rate-limiting or out of quota (HTTP 429). The key itself may be fine.${suffix}`;
  }
  if (status === 402) {
    return `Your provider reports a billing problem (HTTP 402) — often an empty balance.${suffix}`;
  }
  if (status >= 500) {
    return `Your provider returned a server error (HTTP ${status}). This is on their side; try again shortly.${suffix}`;
  }
  return `Your provider returned HTTP ${status}.${suffix}`;
}

export type ProbeOptions = {
  /** Injected in tests. Never call a real provider from the test suite. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * One deliberately minimal chat completion against the user's own endpoint.
 *
 * `max_tokens: 1` and a two-word prompt: enough for the provider to
 * authenticate, resolve the model and bill a fraction of a cent, and not
 * enough to be worth abusing as a free proxy. This is also why the route in
 * front of it is rate-limited.
 */
export async function probeTextCredential(
  credential: TextCredential,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS);

  try {
    const res = await doFetch(credential.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential.apiKey}`,
      },
      body: JSON.stringify({
        model: credential.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const provider = sanitizeProviderMessage(extractProviderMessage(body), credential.apiKey);
      return { ok: false, status: res.status, message: explainStatus(res.status, provider) };
    }

    // A 200 with an unparseable body means something in front of the provider
    // answered (a captive portal, a misconfigured proxy) — not a working key.
    const data = (await res.json().catch(() => null)) as
      | { choices?: unknown[]; error?: unknown }
      | null;
    if (!data || !Array.isArray(data.choices)) {
      return {
        ok: false,
        status: res.status,
        message:
          'The endpoint answered, but not with an OpenAI-compatible completion. Check that the API endpoint is the right one for this provider.',
      };
    }

    return {
      ok: true,
      status: res.status,
      message: `Your key works. ${credential.model} answered on ${new URL(credential.endpoint).host}.`,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    if (aborted) {
      return {
        ok: false,
        status: null,
        message: 'Your endpoint did not respond in time. Check the API endpoint is reachable.',
      };
    }
    // The raw network error can contain the URL but never the key; still, only
    // a fixed message is returned, and the detail is logged server-side by the
    // caller.
    return {
      ok: false,
      status: null,
      message:
        'Could not reach your endpoint at all. Check the API endpoint URL — it must be an https address your provider serves.',
    };
  } finally {
    clearTimeout(timer);
  }
}
