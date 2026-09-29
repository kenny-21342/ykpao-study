import type { TextCredential } from '@/lib/ai-credentials';

/**
 * Which model to ask for, when the configured one is not being served.
 *
 * The shared key points at an aggregator gateway that multiplexes several
 * upstream providers, and what it serves changes without notice. On 29 Sep 2026
 * the model the platform was configured for (`gpt-4o-mini`) returned
 * `500 upstream error: do request failed` on six of six calls, while three
 * other models on the same key and the same endpoint answered six of six. The
 * code's own fallback default, `deepseek-chat`, had stopped being served
 * altogether (`503 No available channel for model`). Marking was down for every
 * user for 36 days over a model name.
 *
 * So this module does not ask the gateway what it *offers* -- `GET /v1/models`
 * listed `gpt-4o-mini` throughout, and listing is not availability. It learns
 * from what actually happened: a model that just failed in a way that means
 * "this model is not being served" goes to the back of the queue for a while,
 * so subsequent calls land on whatever is currently working.
 *
 * Why failing over is nearly free here, measured on the same gateway: a failure
 * comes back in 0.4-2.3s, a success takes 5-9s. Walking past a dead model costs
 * about a fifth of one successful call, and the alternative is no grade at all.
 *
 * State is per-instance and in memory on purpose. A table would mean a write on
 * every AI call to save at most one 1.4s failover on a cold instance, and the
 * serverless platform reuses instances, so a warm one pays nothing. Cold
 * instances re-learn; they do not break.
 */

/**
 * How long a model stays deprioritised after failing.
 *
 * Long enough that a burst of grading inside one submission does not keep
 * re-testing a dead model, short enough that a recovered one comes back without
 * a deploy. The cost of it being too long is a slightly worse model; the cost of
 * it being too short is a wasted call per grade, so err long.
 */
const COOLDOWN_MS = Number(process.env.AI_MODEL_COOLDOWN_MS || 10 * 60_000);

/**
 * Statuses that mean "not this model" rather than "not this key" or "not now".
 *
 * 404 is the gateway's `model_not_found`; 5xx is its `upstream error` and
 * `No available channel for model`. Both are properties of the model or the
 * channel behind it, so another model on the same key may well work.
 *
 * Deliberately NOT here:
 *   429 -- the quota belongs to the key, which every candidate shares. Failing
 *         over spends the same budget faster and makes the throttle worse.
 *   401/403 -- the key is rejected. No model will fix that.
 *   499 -- the caller hung up. Nothing failed.
 */
function meansModelUnavailable(status: number): boolean {
  return status === 404 || status === 502 || status === 503 || status === 500;
}

type Health = { failedAt: number; status: number };

const health = new Map<string, Health>();

function cooling(model: string, now: number): boolean {
  const entry = health.get(model);
  if (!entry) return false;
  if (now - entry.failedAt >= COOLDOWN_MS) {
    health.delete(model);
    return false;
  }
  return true;
}

/** Parse the configured fallback list. Order is the operator's preference. */
function configuredFallbacks(): string[] {
  return (process.env.SHARED_AI_FALLBACK_MODELS || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

/**
 * The models to try for this call, best first.
 *
 * A student's own key gets exactly the model they configured and nothing else.
 * Their endpoint may serve only that one, the name may be spelled for their
 * provider alone, and silently billing them for a model they did not choose
 * would be wrong however well-intentioned. Failover is for the shared key,
 * whose model name is an operator's deployment detail rather than a user's
 * choice.
 */
export function candidateModels(credential: TextCredential, now = Date.now()): string[] {
  if (credential.source !== 'shared') return [credential.model];

  const ordered = [credential.model, ...configuredFallbacks()];
  const seen = new Set<string>();
  const unique = ordered.filter((m) => m && !seen.has(m) && seen.add(m));
  if (unique.length < 2) return unique;

  // Stable partition, not a sort: a model in cooldown goes behind every healthy
  // one but keeps its configured position relative to the others in its group.
  // Nothing is dropped -- if every candidate is cooling we still try them all
  // in preference order, because a stale cooldown must never mean "no grade".
  const healthy = unique.filter((m) => !cooling(m, now));
  const resting = unique.filter((m) => cooling(m, now));
  return [...healthy, ...resting];
}

/** Record what a request to `model` did, so the next call can order better. */
export function noteModelOutcome(model: string, status: number | 'ok'): void {
  if (status === 'ok') {
    health.delete(model);
    return;
  }
  if (meansModelUnavailable(status)) {
    health.set(model, { failedAt: Date.now(), status });
  }
}

/** Test seam, and a way for an operator script to force a re-probe. */
export function resetModelHealth(): void {
  health.clear();
}

/** For diagnostics: which models are currently being skipped, and why. */
export function modelHealthSnapshot(): Array<{ model: string; status: number; ageMs: number }> {
  const now = Date.now();
  return [...health.entries()]
    .filter(([model]) => cooling(model, now))
    .map(([model, h]) => ({ model, status: h.status, ageMs: now - h.failedAt }));
}
