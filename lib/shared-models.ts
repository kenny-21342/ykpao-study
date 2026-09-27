/**
 * The models a student may choose for the shared AI key, and which of them are
 * answering right now.
 *
 * The shared key points at a New API gateway that a friend of the site owner
 * operates and funds. It is not a fixed menu: of the twenty models it carries,
 * thirteen were down at the moment this was written, and which thirteen
 * changes through the day. A hardcoded list would therefore be wrong most of
 * the time -- offering models that cannot answer, and hiding ones that can.
 *
 * Two sources, and both are needed — using either alone is wrong:
 *
 *  - **The gateway's own `/v1/models`** decides *which* models exist for us.
 *    That list is scoped to the key's token group, and ours is narrower than
 *    the gateway as a whole: it returns 7 models where the status page watches
 *    20. Models the page shows as UP, including `claude-sonnet-4-6` and
 *    `moonshotai/kimi-k3`, answer this key with `503 model_not_found`. A
 *    catalogue built from the status page alone would offer students models
 *    that cannot serve them.
 *  - **The status page** decides which of those are *answering*, because
 *    `/v1/models` lists a model whether or not its channel is healthy.
 *
 * So the gateway's list is the spine and the status page is an overlay. A
 * model the gateway offers but nobody watches is assumed available: the
 * gateway is the authority on its own line-up, and the page's silence is
 * absence of evidence.
 *
 * None of these are free. They draw down the operator's credit, so they must
 * never appear in `FREE_MODELS` (lib/ai-pricing.ts): the per-user monthly cap
 * is the only thing bounding what a year group can spend here.
 */

export type SharedModelChoice = {
  /** The id sent to the provider — the monitor's name on the status page. */
  id: string;
  /** What the picker shows: the id with its vendor prefix removed. */
  label: string;
  /** The status page's group name: OpenAI, Anthropic, Kimi, … */
  vendor: string;
  /** Whether the most recent heartbeat was a success. */
  up: boolean;
};

const STATUS_PAGE = 'https://stat.hxi.me/api/status-page/ai';
const STATUS_HEARTBEAT = 'https://stat.hxi.me/api/status-page/heartbeat/ai';

/**
 * Groups that describe the gateway itself rather than a model it serves.
 *
 * `北京检测节点` ("Beijing probe node") holds `yang-api`, a monitor on the
 * gateway's own reachability. Offering it as a model would send a student's
 * question to something that is not one.
 */
const NON_MODEL_GROUPS = ['北京检测节点'];

/**
 * What the picker falls back to when the gateway's model list cannot be read.
 *
 * One entry, deliberately: the fastest model the key can reach, measured at
 * 2.1s against 29s for `gpt-6-astra` on the same prompt. This is not a menu,
 * it is the guarantee that a student can still ask a question when a lookup
 * fails, so it holds the model least likely to make them wait.
 */
export const FALLBACK_MODELS: readonly SharedModelChoice[] = [
  { id: 'gpt-4o-mini', label: 'gpt-4o-mini', vendor: 'OpenAI', up: true },
] as const;

/** Strip the `vendor/` prefix an id may carry; `gpt-4o` and `z-ai/glm-5.2` both read well. */
export function modelLabel(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash === -1 ? id : id.slice(slash + 1);
}

type StatusPage = {
  publicGroupList?: Array<{ name?: string; monitorList?: Array<{ id?: number; name?: string }> }>;
};
type Heartbeats = { heartbeatList?: Record<string, Array<{ status?: number }>> };

/** What the status page knows about one model: its vendor, and whether it is up. */
type Watched = { vendor: string; up: boolean };

/**
 * Index the status page by model id.
 *
 * Exported for the test, which feeds it recorded payloads: the shape is a
 * third party's, and this must not start including the probe monitor or
 * silently returning nothing without something failing.
 */
export function watchedFrom(page: StatusPage, beats: Heartbeats): Map<string, Watched> {
  const watched = new Map<string, Watched>();
  for (const group of page.publicGroupList ?? []) {
    const vendor = (group.name ?? '').trim();
    if (!vendor || NON_MODEL_GROUPS.includes(vendor)) continue;
    for (const monitor of group.monitorList ?? []) {
      const id = (monitor.name ?? '').trim();
      if (!id || monitor.id === undefined) continue;
      const history = beats.heartbeatList?.[String(monitor.id)] ?? [];
      // The last beat, not any beat: a model that failed its most recent check
      // is down now, whatever it was doing an hour ago.
      const last = history[history.length - 1];
      watched.set(id, { vendor, up: last?.status === 1 });
    }
  }
  return watched;
}

/**
 * Combine the gateway's model list with the status page's view of it.
 *
 * `ids` is the spine — only what the key can actually reach appears. A model
 * nobody watches is treated as up, because the gateway listing it is better
 * evidence than a monitor that does not exist.
 *
 * Exported for the test, which is where the "UP on the page but 503 for this
 * key" case is pinned.
 */
export function mergeCatalogue(ids: string[], watched: Map<string, Watched>): SharedModelChoice[] {
  return ids
    .map((id) => {
      const seen = watched.get(id);
      return {
        id,
        label: modelLabel(id),
        // The status page's grouping when it has one, otherwise the vendor
        // prefix the id carries, otherwise unknown. Never guessed from the
        // name: `gpt-4` is almost certainly OpenAI, but "almost certainly" is
        // not something to print next to a student's choice.
        vendor: seen?.vendor ?? (id.includes('/') ? id.slice(0, id.indexOf('/')) : 'Other'),
        up: seen?.up ?? true,
      };
    })
    .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.label.localeCompare(b.label));
}

/** The chat-completions base, without the `/chat/completions` suffix if present. */
function gatewayBase(): string | null {
  const raw = process.env.SHARED_AI_BASE_URL || process.env.DEEPSEEK_API_URL;
  if (!raw) return null;
  return raw.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
}

let cache: { at: number; models: SharedModelChoice[] } | null = null;
let inFlight: Promise<SharedModelChoice[]> | null = null;

/**
 * The status page refreshes every 300s and beats every 60s, so a minute is
 * fresh enough to be useful and slow enough to be polite to someone else's
 * server.
 */
const CACHE_TTL_MS = 60_000;

/**
 * The catalogue, cached per instance.
 *
 * Never throws and never returns empty: a student who opens the tutor while
 * one of these lookups is failing still gets a working tutor. Concurrent
 * misses share one request rather than each making their own, the same reason
 * `/api/platform-stats` does.
 *
 * The status page failing is survivable — every model is then assumed up, and
 * the server's resolver falls back on a real provider error if one is not. The
 * gateway's own list failing is not, because without it we do not know what
 * the key may call, so that case falls back to `FALLBACK_MODELS`.
 */
export async function loadSharedModels(
  options: { timeoutMs?: number } = {},
): Promise<SharedModelChoice[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;
  // Measured from the owner's machine on 27 Sep 2026: both lookups are spiky,
  // 0.4-1.2s warm and 6.1s cold. The default is generous because the caller is
  // usually the tutor *opening*, where a second or two costs nothing. The
  // request path passes something much tighter -- see `/api/ai/rag-chat`.
  const timeoutMs = options.timeoutMs ?? 12_000;
  inFlight ??= (async () => {
    try {
      const base = gatewayBase();
      const apiKey = process.env.SHARED_AI_API_KEY || process.env.DEEPSEEK_API_KEY;
      if (!base || !apiKey) return cache?.models ?? [...FALLBACK_MODELS];

      const [gatewayRes, watched] = await Promise.all([
        fetch(`${base}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(timeoutMs),
        }),
        loadWatched(timeoutMs),
      ]);
      if (!gatewayRes.ok) throw new Error(`gateway /models ${gatewayRes.status}`);
      const payload = await gatewayRes.json();
      const ids: string[] = (payload?.data ?? [])
        .map((entry: { id?: unknown }) => (typeof entry.id === 'string' ? entry.id.trim() : ''))
        .filter(Boolean);
      if (ids.length === 0) throw new Error('gateway listed no models');

      const models = mergeCatalogue(ids, watched);
      cache = { at: Date.now(), models };
      return models;
    } catch (error) {
      console.warn('[shared-models] catalogue unavailable:', error instanceof Error ? error.message : error);
      // Keep serving the last good catalogue if there is one; the models did
      // not disappear just because a lookup did.
      return cache?.models ?? [...FALLBACK_MODELS];
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** The status-page overlay. Its failure is not the catalogue's failure. */
async function loadWatched(timeoutMs: number): Promise<Map<string, Watched>> {
  try {
    const [pageRes, beatRes] = await Promise.all([
      fetch(STATUS_PAGE, { signal: AbortSignal.timeout(timeoutMs) }),
      fetch(STATUS_HEARTBEAT, { signal: AbortSignal.timeout(timeoutMs) }),
    ]);
    if (!pageRes.ok || !beatRes.ok) throw new Error(`status page ${pageRes.status}/${beatRes.status}`);
    return watchedFrom(await pageRes.json(), await beatRes.json());
  } catch (error) {
    console.warn('[shared-models] status page unavailable:', error instanceof Error ? error.message : error);
    // Empty overlay: every gateway model is then treated as up, which is the
    // right way to fail. Hiding models because a monitor is unreachable would
    // take the tutor down over someone else's uptime page.
    return new Map();
  }
}

/**
 * Resolve the model a request should actually use.
 *
 * Three jobs, in order, and the second is why this is not a plain allowlist
 * check: honour a valid choice, route around a model that is down, and refuse
 * anything not on the gateway at all.
 *
 * `requested` comes off an attacker-controlled request body. Without the
 * membership test it could name any model the gateway sells — including the
 * most expensive one — on the owner's credit.
 *
 * A requested model that exists but is currently down falls through to an
 * available one rather than erroring, because that is the ordinary case here
 * rather than a rare one, and a student should not have to understand a
 * provider outage to get an answer.
 */
export function resolveSharedModel(
  models: readonly SharedModelChoice[],
  requested: string | null | undefined,
  configured: string,
): string {
  const chosen = models.find((model) => model.id === requested);
  if (chosen?.up) return chosen.id;
  const configuredModel = models.find((model) => model.id === configured);
  if (configuredModel?.up) return configuredModel.id;
  const anyUp = models.find((model) => model.up);
  // Nothing up anywhere: send the configured model and let the provider answer
  // for itself. The status page can be wrong, and a real error from the
  // gateway is more useful than a refusal invented here.
  return anyUp?.id ?? configured;
}
