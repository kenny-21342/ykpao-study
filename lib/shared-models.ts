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
 * So the catalogue is read from the gateway operator's own Uptime Kuma status
 * page, which publishes one monitor per model, grouped by vendor, with a
 * heartbeat each minute. It needs no credential, which is why the server can
 * poll it and the tutor can show a student what is actually up before they
 * pick.
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
 * What the picker falls back to when the status page cannot be reached.
 *
 * Deliberately short and boring: the two models that were up longest during
 * observation, from different vendors, so a single vendor outage does not take
 * both. This exists so that the status page being down degrades the choice
 * rather than the tutor — a student must still be able to ask a question.
 */
export const FALLBACK_MODELS: readonly SharedModelChoice[] = [
  { id: 'gpt-4o-mini', label: 'gpt-4o-mini', vendor: 'OpenAI', up: true },
  { id: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', vendor: 'Anthropic', up: true },
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

/**
 * Build the catalogue from the status page.
 *
 * Exported for the test, which feeds it recorded payloads rather than the
 * live page: the shape is a third party's and this must not start returning
 * the probe monitor, or an empty list, without something failing.
 */
export function catalogueFrom(page: StatusPage, beats: Heartbeats): SharedModelChoice[] {
  const models: SharedModelChoice[] = [];
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
      models.push({ id, label: modelLabel(id), vendor, up: last?.status === 1 });
    }
  }
  return models;
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
 * someone else's status page is down still gets a working tutor. Concurrent
 * misses share one request rather than each making their own, the same reason
 * `/api/platform-stats` does.
 */
export async function loadSharedModels(): Promise<SharedModelChoice[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.models;
  inFlight ??= (async () => {
    try {
      const [pageRes, beatRes] = await Promise.all([
        fetch(STATUS_PAGE, { signal: AbortSignal.timeout(6_000) }),
        fetch(STATUS_HEARTBEAT, { signal: AbortSignal.timeout(6_000) }),
      ]);
      if (!pageRes.ok || !beatRes.ok) throw new Error(`status page ${pageRes.status}/${beatRes.status}`);
      const models = catalogueFrom(await pageRes.json(), await beatRes.json());
      if (models.length === 0) throw new Error('status page listed no models');
      cache = { at: Date.now(), models };
      return models;
    } catch (error) {
      console.warn('[shared-models] status page unavailable:', error instanceof Error ? error.message : error);
      // Keep serving the last good catalogue if there is one; the models did
      // not disappear just because the page monitoring them did.
      return cache?.models ?? [...FALLBACK_MODELS];
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
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
