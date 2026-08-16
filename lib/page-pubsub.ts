/**
 * Postgres LISTEN/NOTIFY helpers for real-time page collaboration.
 *
 * Two channels per page:
 *   - `page_<id>`         — awareness deltas (cursor moves, typing, join/leave)
 *   - `page_<id>_rev`     — content revision bumps (triggers auto-refresh)
 *
 * NOTIFY payloads are JSON strings capped at 8 KB (Postgres limit); awareness
 * payloads are tiny (~200 bytes), well within the limit.
 *
 * A dedicated `pg.Pool` is used (separate from Prisma's) because LISTEN holds
 * a dedicated client connection for the lifetime of the SSE stream.
 */

import { Pool, type PoolClient } from 'pg';

/**
 * LISTEN requires a session that stays pinned to one backend for the life of
 * the subscription. A transaction-mode connection pooler (pgbouncer, Neon's
 * `-pooler` endpoint, Supabase's port 6543) hands the connection back after
 * every statement, so `LISTEN` appears to succeed and then silently delivers
 * nothing — collaboration looks connected and simply never updates.
 *
 * That is the worst possible failure mode, so it gets its own connection
 * string and an explicit warning rather than being left to chance.
 */
const POOLED_URL_MARKERS = [
  '-pooler', // Neon
  'pgbouncer=true', // Supabase / generic
  ':6543', // Supabase transaction-mode port
];

function resolvePubsubConnectionString(): string | undefined {
  const direct = process.env.DIRECT_DATABASE_URL;
  const url = direct || process.env.DATABASE_URL;
  if (!url) return undefined;

  const looksPooled = POOLED_URL_MARKERS.some((marker) => url.includes(marker));
  if (looksPooled) {
    console.warn(
      '[page-pubsub] The connection string used for LISTEN/NOTIFY looks like a ' +
        'transaction-mode pooler (%s). LISTEN does not work through one: ' +
        'real-time collaboration will connect but never receive updates. ' +
        'Set DIRECT_DATABASE_URL to the direct (unpooled) connection string.',
      POOLED_URL_MARKERS.find((m) => url.includes(m)),
    );
  }
  return url;
}

const pool = new Pool({
  connectionString: resolvePubsubConnectionString(),
  // Collab is SSE-based; cap concurrent listeners so we never starve the pool.
  max: 20,
  idleTimeoutMillis: 30_000,
});

export type AwarenessPayload = {
  userId: string;
  userName: string | null;
  userImage: string | null;
  userColor: string;
  cursorFrom: number | null;
  cursorTo: number | null;
  typing: boolean;
  left?: boolean; // true when the user disconnected
};

export type RevisionPayload = {
  pageId: string;
  revision: number;
  savedBy: string;
};

/**
 * Build the Postgres channel name for awareness events on a page.
 * Only [a-z0-9_] are safe in LISTEN/NOTIFY channel names; the pageId (a cuid)
 * already matches that charset.
 */
export function awarenessChannel(pageId: string): string {
  return `page_${pageId.replace(/[^a-z0-9_]/gi, '')}`;
}

export function revisionChannel(pageId: string): string {
  return `page_${pageId.replace(/[^a-z0-9_]/gi, '')}_rev`;
}

/** Fire-and-forget NOTIFY for an awareness update. Safe to call from any route. */
export async function notifyAwareness(pageId: string, payload: AwarenessPayload) {
  const channel = awarenessChannel(pageId);
  // pg_notify accepts any string as channel name (unlike the LISTEN parser,
  // which requires a literal identifier); this sidesteps quoting issues.
  await pool.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(payload)]);
}

/** Fire-and-forget NOTIFY for a content revision bump. */
export async function notifyRevision(pageId: string, payload: RevisionPayload) {
  const channel = revisionChannel(pageId);
  await pool.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(payload)]);
}

/**
 * Acquire a dedicated Postgres client and start LISTENing on both channels.
 * Returns the client plus a cleanup function that UNLISTENs and releases.
 *
 * The caller is responsible for wiring `client.on('notification', ...)` to
 * forward events to its SSE listeners.
 */
export async function listenToPage(pageId: string): Promise<{
  client: PoolClient;
  awarenessChan: string;
  revisionChan: string;
  cleanup: () => Promise<void>;
}> {
  const client = await pool.connect();
  const awarenessChan = awarenessChannel(pageId);
  const revisionChan = revisionChannel(pageId);

  // pg-node doesn't interpolate identifiers safely in LISTEN, but these names
  // are built from a sanitized cuid so they're safe as raw SQL.
  await client.query(`LISTEN "${awarenessChan}"`);
  await client.query(`LISTEN "${revisionChan}"`);

  const cleanup = async () => {
    try {
      await client.query(`UNLISTEN "${awarenessChan}"`);
      await client.query(`UNLISTEN "${revisionChan}"`);
    } catch {
      // best-effort
    }
    client.release();
  };

  return { client, awarenessChan, revisionChan, cleanup };
}

/**
 * The pool used for LISTEN/NOTIFY. Exposed so tests / health checks can
 * inspect the connection count; do NOT use this for regular queries.
 */
export const pubsubPool = pool;
