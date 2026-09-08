/**
 * Shared configuration for the app's Server-Sent Events endpoints.
 *
 * Both streams originally ran for 10 minutes per connection. That is longer
 * than a serverless function is allowed to live: the platform kills the
 * invocation mid-stream, which the browser sees as a network error rather than
 * a clean end-of-stream. EventSource still reconnects, so it "works", but every
 * client takes an error path on a fixed cycle forever.
 *
 * Capping our own lifetime below the platform limit means *we* close the
 * stream cleanly and the client reconnects on the normal path.
 */

/**
 * Default max lifetime of one SSE connection, in milliseconds.
 *
 * 50s, comfortably under the 60s `maxDuration` the stream routes declare (which
 * is itself Vercel Hobby's ceiling). The default is deliberately the *safe*
 * value rather than the generous one: too long and the platform kills every
 * stream mid-flight, which the browser cannot distinguish from a network fault.
 * Raise `SSE_MAX_LIFETIME_MS` — and `maxDuration` with it — on a plan that
 * allows longer functions.
 */
const DEFAULT_STREAM_LIFETIME_MS = 50_000;

/** Hard bounds — a stream shorter than this reconnects wastefully. */
const MIN_LIFETIME_MS = 30_000;
const MAX_LIFETIME_MS = 15 * 60_000;

/**
 * How long a single SSE connection is allowed to stay open.
 *
 * Override with `SSE_MAX_LIFETIME_MS` to match your platform's function
 * timeout (set it a little *below* that timeout, never above).
 */
export function streamLifetimeMs(): number {
  const raw = Number.parseInt(process.env.SSE_MAX_LIFETIME_MS ?? '', 10);
  if (!Number.isFinite(raw)) return DEFAULT_STREAM_LIFETIME_MS;
  return Math.min(Math.max(raw, MIN_LIFETIME_MS), MAX_LIFETIME_MS);
}

/**
 * Whether real-time collaboration over SSE is enabled.
 *
 * Set `COLLAB_REALTIME=off` on a deployment where LISTEN/NOTIFY cannot work
 * (for example, only a pooled connection string is available). The stream
 * endpoint then reports that cleanly instead of holding open a connection
 * that will never deliver an event.
 */
export function isRealtimeCollabEnabled(): boolean {
  return (process.env.COLLAB_REALTIME ?? 'sse').toLowerCase() !== 'off';
}

/**
 * Whether real CRDT (Yjs) content merging is enabled for the Notebook page
 * editor, replacing the default last-write-wins/conflict-banner behavior.
 *
 * Defaults OFF (opt-in via `YJS_COLLAB=on`) -- the opposite default from
 * `isRealtimeCollabEnabled` above, deliberately: this feature is additive
 * and new, not a fallback for when something else is unavailable, so silent
 * enablement is the wrong default. `Page.content` stays the authoritative
 * HTML mirror regardless of this flag; flipping it off at any time loses no
 * data, since the CRDT log (`PageYjsUpdate`/`PageYjsSnapshot`) is a purely
 * additive side-channel.
 */
export function isYjsCollabEnabled(): boolean {
  return (process.env.YJS_COLLAB ?? 'off').toLowerCase() === 'on';
}
