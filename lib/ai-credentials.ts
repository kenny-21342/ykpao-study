// Relative, extension-bearing imports (the convention lib/env.ts already
// uses) so this module is loadable by the plain-node test runner as well as by
// Next — the resolution rules below are worth testing without a database.
import { decryptSecret, isCredentialEncryptionConfigured } from './credential-crypto.ts';

/**
 * Per-user resolution of AI credentials — the single place that decides
 * whether an AI feature is on, off, or partially on for a given account.
 *
 * The platform used to call Anthropic/DeepSeek/Gemini/SiliconFlow with the
 * owner's server keys behind a monthly spend cap. It no longer pays for
 * students' usage, so the model is bring-your-own-key:
 *
 *   1. The user's own key, endpoint and model names, if they saved any.
 *   2. Otherwise the owner's shared server key — but ONLY for accounts an
 *      admin has explicitly granted, for demos and for students who genuinely
 *      cannot obtain a key of their own.
 *   3. Otherwise AI is off, and every entry point says so in words the student
 *      can act on.
 *
 * There is deliberately no general fallback to step 2: an ungranted account
 * with no key of its own gets the disabled state, never the owner's bill.
 *
 * Nothing here is provider-specific. Students will point this at OpenAI,
 * DeepSeek, SiliconFlow, OpenRouter and school proxies alike, so the only
 * assumption made is the one the codebase already relies on — an
 * OpenAI-compatible `/chat/completions` endpoint. The one exception is the
 * owner's own Gemini key, which predates this and still uses the native API.
 */

export type AiCredentialSource = 'user' | 'shared';

export type TextCredential = {
  source: AiCredentialSource;
  apiKey: string;
  /** Fully-qualified chat-completions URL. */
  endpoint: string;
  model: string;
};

export type VisionCredential = {
  source: AiCredentialSource;
  /**
   * How to shape the request. User-supplied endpoints are always treated as
   * OpenAI-compatible; `gemini` only ever arises from the owner's server key.
   */
  provider: 'openai-compatible' | 'gemini';
  apiKey: string;
  endpoint: string;
  model: string;
};

/** What the settings UI and the admin console need to render the state. */
export type AiCredentialStatus = {
  hasOwnKey: boolean;
  sharedKeyAccess: boolean;
  sharedKeyAvailable: boolean;
  source: AiCredentialSource | null;
  textEnabled: boolean;
  visionEnabled: boolean;
  keyHint: string | null;
  baseUrl: string | null;
  textModel: string | null;
  visionModel: string | null;
  encryptionConfigured: boolean;
  /** True when a stored key exists but cannot be opened with the current key. */
  keyUndecryptable: boolean;
};

// ---------------------------------------------------------------------------
// Endpoint normalisation
// ---------------------------------------------------------------------------

/**
 * Turn whatever a student pasted into a chat-completions URL.
 *
 * They will paste all three of these, and all three must work:
 *   https://api.deepseek.com                     -> …/v1/chat/completions
 *   https://api.deepseek.com/v1                  -> …/v1/chat/completions
 *   https://api.deepseek.com/v1/chat/completions -> unchanged
 */
export function toChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v\d+[a-z0-9]*$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

/** Host suffixes that only ever name something inside the network. */
const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain'];

/**
 * True if `hostname` is a literal address inside the machine or its network.
 *
 * The URL parser has already normalised the exotic IPv4 spellings for us --
 * `2130706433` and `0177.0.0.1` both arrive here as `127.0.0.1` -- so matching
 * on the dotted-quad is enough for those.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;

  if (host === 'localhost') return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  // IPv6, including the IPv4-mapped form (::ffff:127.0.0.1).
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    // fc00::/7 unique-local, fe80::/10 link-local.
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
    // IPv4-mapped addresses arrive in either spelling: the URL parser rewrites
    // `::ffff:127.0.0.1` to `::ffff:7f00:1`, so the hex form has to be decoded
    // back to a dotted quad or loopback walks straight through.
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (dotted) return isPrivateHost(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (hex) {
      const high = Number.parseInt(hex[1], 16);
      const low = Number.parseInt(hex[2], 16);
      return isPrivateHost(
        `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
      );
    }
    return false;
  }

  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!quad) return false;
  const [a, b] = [Number(quad[1]), Number(quad[2])];

  if (a === 0) return true;                        // 0.0.0.0/8 "this host"
  if (a === 10) return true;                       // private
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true;         // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * Reject anything that is not a plain https endpoint before it is stored.
 *
 * http:// would put the student's bearer token on the wire in clear, and any
 * other scheme is either a typo or an attempt to make the server fetch
 * something local.
 *
 * The host check matters because "test my key" makes the server fetch a URL
 * the user supplies. Blocking only the string "localhost" left 127.0.0.1,
 * [::1], 10.0.0.5, 192.168.1.1 and -- worst -- 169.254.169.254, the cloud
 * metadata address, all reachable.
 *
 * This blocks literals, which is where the bar belongs for a stored setting.
 * It is NOT a complete SSRF defence: a public hostname that resolves to a
 * private address, or one that changes its answer between this check and the
 * fetch, still gets through. Closing that needs the resolved IP to be checked
 * at request time and redirects refused, at the point of the fetch.
 */
export function validateBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!url.hostname || isPrivateHost(url.hostname)) return null;
  return url.toString().replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------
// The owner's shared server key
// ---------------------------------------------------------------------------

/**
 * The shared text credential, from the same env vars the platform used before
 * BYOK. Reachable only by accounts an admin granted; it still spends the
 * owner's money and therefore still passes the monthly cap.
 */
export function sharedTextCredential(): TextCredential | null {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  return {
    source: 'shared',
    apiKey,
    endpoint:
      process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  };
}

/**
 * The same credential, pointed at a lower-latency model.
 *
 * Some calls have a student waiting on them -- the tutor, a hint, marking one
 * free-response answer -- and some do not. Measured against the shared
 * provider, a call's median is 7-27 seconds with a tail past 90, which a person
 * watching a spinner cannot absorb: the tutor and mock generation both timed
 * out in production at the 45s budget. Where a faster model is configured,
 * interactive calls use it and batch work keeps the better one.
 *
 * Only the shared credential is switched. A student who supplied their own key
 * chose their own model, and quietly substituting a different one would spend
 * their money on something they did not ask for.
 */
export function forInteractive(credential: TextCredential): TextCredential {
  const fast = process.env.AI_INTERACTIVE_MODEL;
  if (!fast || credential.source !== 'shared') return credential;
  return { ...credential, model: fast };
}

/**
 * Host every SiliconFlow request goes to; also what makes the alias below safe.
 */
const SILICONFLOW_HOST = 'api.siliconflow.cn';

/**
 * The owner's SiliconFlow key, under either of its two names.
 *
 * SILICONFLOW_API_KEY is canonical, but the V3 batch scripts and the Python
 * extraction pipeline have always read V3_OPENAI_API_KEY for the same key, so
 * one value anywhere in the environment powers both sides. The alias is only
 * honoured while V3_OPENAI_CHAT_COMPLETIONS_URL is unset or points at
 * SiliconFlow: a key issued for some other OpenAI-compatible provider must
 * never be sent to SiliconFlow.
 *
 * Read on each call rather than at module load, so a process that populates
 * the environment late (and the tests) sees what the request path will.
 */
export function siliconflowKey(): string {
  const direct = process.env.SILICONFLOW_API_KEY;
  if (direct) return direct;

  const pipelineEndpoint = process.env.V3_OPENAI_CHAT_COMPLETIONS_URL;
  if (pipelineEndpoint && !pipelineEndpoint.includes(SILICONFLOW_HOST)) return '';

  return process.env.V3_OPENAI_API_KEY || '';
}

/** The shared vision credential — SiliconFlow first, then Gemini, as before. */
export function sharedVisionCredential(): VisionCredential | null {
  const siliconflow = siliconflowKey();
  if (siliconflow) {
    return {
      source: 'shared',
      provider: 'openai-compatible',
      apiKey: siliconflow,
      endpoint: `https://${SILICONFLOW_HOST}/v1/chat/completions`,
      model: process.env.VISION_MODEL || 'Qwen/Qwen3-VL-32B-Instruct',
    };
  }
  const gemini = process.env.GEMINI_API_KEY;
  if (gemini) {
    return {
      source: 'shared',
      provider: 'gemini',
      apiKey: gemini,
      endpoint:
        process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta',
      model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    };
  }
  return null;
}

/** True when the owner has a server key at all, for the admin console. */
export function isSharedAiConfigured(): boolean {
  return sharedTextCredential() !== null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type ResolvedAi = {
  text: TextCredential | null;
  vision: VisionCredential | null;
  status: AiCredentialStatus;
};

export type CredentialRow = {
  encryptedApiKey: string | null;
  keyHint: string | null;
  baseUrl: string | null;
  textModel: string | null;
  visionModel: string | null;
  sharedKeyAccess: boolean;
};

function emptyStatus(): AiCredentialStatus {
  return {
    hasOwnKey: false,
    sharedKeyAccess: false,
    sharedKeyAvailable: isSharedAiConfigured(),
    source: null,
    textEnabled: false,
    visionEnabled: false,
    keyHint: null,
    baseUrl: null,
    textModel: null,
    visionModel: null,
    encryptionConfigured: isCredentialEncryptionConfigured(),
    keyUndecryptable: false,
  };
}

/**
 * Resolve everything about a user's AI access in one database round trip.
 *
 * Callers that only need a gate should use `requireTextAi` / `requireVisionAi`
 * below; this is for the settings and admin surfaces that render the state.
 */
export async function resolveAiCredentials(userId: string): Promise<ResolvedAi> {
  let row: CredentialRow | null = null;
  try {
    const { prisma } = await import('./prisma.ts');
    row = await prisma.userAiCredential.findUnique({
      where: { userId },
      select: {
        encryptedApiKey: true,
        keyHint: true,
        baseUrl: true,
        textModel: true,
        visionModel: true,
        sharedKeyAccess: true,
      },
    });
  } catch (error) {
    // The table is created by a hand-written migration the owner applies
    // separately; until then, treat AI as off rather than 500-ing every route.
    console.error('[ai-credentials] lookup failed for user %s:', userId, error);
    return { text: null, vision: null, status: emptyStatus() };
  }

  return resolveFromRow(row, userId);
}

/**
 * The resolution rules themselves, as a pure function of the stored row.
 *
 * Split out from the query so the three-way order (own key → admin-granted
 * shared key → off) can be tested without a database, which is exactly where
 * a regression would be most expensive: silently falling back to the owner's
 * key for an ungranted student is a bill, not a bug report.
 */
export function resolveFromRow(row: CredentialRow | null, userId = 'unknown'): ResolvedAi {
  const status = emptyStatus();

  if (!row) return { text: null, vision: null, status };

  status.sharedKeyAccess = row.sharedKeyAccess;
  status.keyHint = row.keyHint;
  status.baseUrl = row.baseUrl;
  status.textModel = row.textModel;
  status.visionModel = row.visionModel;

  // ---- 1. the user's own key ----
  if (row.encryptedApiKey && row.baseUrl && row.textModel) {
    status.hasOwnKey = true;
    let apiKey: string;
    try {
      apiKey = decryptSecret(row.encryptedApiKey);
    } catch (error) {
      // Almost always a rotated CREDENTIAL_ENCRYPTION_KEY. Surface it as a
      // distinct state so the settings page can tell the student to re-enter
      // the key, instead of silently pretending they never saved one.
      console.error('[ai-credentials] could not decrypt stored key for user %s:', userId, error);
      status.keyUndecryptable = true;
      return { text: null, vision: null, status };
    }

    const endpoint = toChatCompletionsUrl(row.baseUrl);
    const text: TextCredential = {
      source: 'user',
      apiKey,
      endpoint,
      model: row.textModel,
    };
    const vision: VisionCredential | null = row.visionModel
      ? {
          source: 'user',
          provider: 'openai-compatible',
          apiKey,
          endpoint,
          model: row.visionModel,
        }
      : null;

    status.source = 'user';
    status.textEnabled = true;
    status.visionEnabled = vision !== null;
    return { text, vision, status };
  }

  // ---- 2. an admin-granted share of the owner's key ----
  if (row.sharedKeyAccess) {
    const text = sharedTextCredential();
    const vision = sharedVisionCredential();
    if (text) {
      status.source = 'shared';
      status.textEnabled = true;
      status.visionEnabled = vision !== null;
      return { text, vision, status };
    }
  }

  // ---- 3. off ----
  return { text: null, vision: null, status };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export const AI_DISABLED_MESSAGE =
  'AI features are switched off for this account because no API key is configured. ' +
  'Open Account Settings → AI Provider and add your own API key, API endpoint and ' +
  'model name to turn them back on, or ask an administrator for shared access.';

export const AI_KEY_UNDECRYPTABLE_MESSAGE =
  'Your saved API key could not be read (the server’s encryption key has changed). ' +
  'Open Account Settings → AI Provider and enter your API key again.';

/**
 * Deliberately specific, per the one rule students will actually hit: a key
 * that only names a text model. Naming the exact features that stop working —
 * and the ones that keep working — is the difference between a student fixing
 * their settings and a student assuming the app is broken.
 */
export function visionDisabledMessage(textModel: string | null): string {
  const model = textModel ? `“${textModel}”` : 'a text-only model';
  return (
    `Handwriting OCR needs a vision-capable (multimodal) model, and your AI Provider ` +
    `settings only name ${model}, which cannot read images. Photographing or ` +
    `hand-drawing an answer, and anything else that reads a picture, is unavailable — ` +
    `typing your answer still works, and so do tutoring, hints, grading and mock exams. ` +
    `To enable it, add a vision model name (for example gpt-4o-mini, ` +
    `Qwen/Qwen3-VL-32B-Instruct or gemini-2.0-flash — it must be one your endpoint ` +
    `serves) under Account Settings → AI Provider.`
  );
}

export type AiDenial = {
  ok: false;
  /** 503: the feature is off for this account, not a transient server fault. */
  status: number;
  error: string;
  reason: 'no-credentials' | 'key-undecryptable' | 'no-vision-model';
};

export type AiGrant<T> = { ok: true; credential: T; source: AiCredentialSource };

function denyFromStatus(status: AiCredentialStatus): AiDenial {
  if (status.keyUndecryptable) {
    return {
      ok: false,
      status: 503,
      error: AI_KEY_UNDECRYPTABLE_MESSAGE,
      reason: 'key-undecryptable',
    };
  }
  return { ok: false, status: 503, error: AI_DISABLED_MESSAGE, reason: 'no-credentials' };
}

/** Gate for every text completion: chat, hints, grading, exam generation. */
export async function requireTextAi(
  userId: string,
): Promise<AiGrant<TextCredential> | AiDenial> {
  return gateText(await resolveAiCredentials(userId));
}

/** The text decision, as a pure function — see `resolveFromRow`. */
export function gateText(resolved: ResolvedAi): AiGrant<TextCredential> | AiDenial {
  const { text, status } = resolved;
  if (!text) return denyFromStatus(status);
  return { ok: true, credential: text, source: text.source };
}

/** Gate for handwriting OCR and anything else that must read an image. */
export async function requireVisionAi(
  userId: string,
): Promise<AiGrant<VisionCredential> | AiDenial> {
  return gateVision(await resolveAiCredentials(userId));
}

/** The vision decision, as a pure function — see `resolveFromRow`. */
export function gateVision(resolved: ResolvedAi): AiGrant<VisionCredential> | AiDenial {
  const { text, vision, status } = resolved;
  if (vision) return { ok: true, credential: vision, source: vision.source };
  // A working text credential with no vision model is the interesting case:
  // the account is not "AI off", it is "AI on, vision missing", and it needs
  // its own message.
  if (text) {
    return {
      ok: false,
      status: 503,
      error: visionDisabledMessage(status.textModel),
      reason: 'no-vision-model',
    };
  }
  return denyFromStatus(status);
}
