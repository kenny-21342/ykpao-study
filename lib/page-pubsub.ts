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

import { pgConfig } from './db-ssl';

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

/**
 * Every LISTEN holds a connection for the life of its SSE stream, so this is
 * a cap on concurrent collaborators per instance, not a throughput knob.
 *
 * It was 20, chosen against a database that allows hundreds. The plan the
 * platform actually runs on allows 20 in total, across every instance, and
 * this pool is not the only claimant -- `lib/prisma.ts` opens its own for
 * every query the app makes.
 *
 * Two, because this pool is only ever used by the notebook page editor.
 * Queries go through Prisma; nothing else subscribes. A student reading a
 * paper or sitting a mock exam never opens one of these, so spending scarce
 * connection slots to keep more of them warm buys nothing. Raise
 * `PUBSUB_POOL_MAX` behind a real connection pooler.
 */
function pubsubPoolMax(): number {
  const raw = Number.parseInt(process.env.PUBSUB_POOL_MAX ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
}

const pubsubConnectionString = resolvePubsubConnectionString();

const pool = new Pool({
  ...(pubsubConnectionString ? pgConfig(pubsubConnectionString) : {}),
  max: pubsubPoolMax(),
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
 * Pointer only -- never the update bytes themselves. Yjs update messages can
 * exceed Postgres's 8KB NOTIFY payload cap, so this just tells other clients
 * "go fetch `updateId` (and anything after it) from `GET
 * /api/pages/[id]/yjs-updates`" the same way `RevisionPayload` says "go
 * re-fetch the page" rather than carrying the new content itself.
 */
export type YjsUpdatePayload = {
  pageId: string;
  updateId: string;
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

export function yjsUpdateChannel(pageId: string): string {
  return `page_${pageId.replace(/[^a-z0-9_]/gi, '')}_yjs`;
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

/** Fire-and-forget NOTIFY that a new Yjs update is available (pointer only). */
export async function notifyYjsUpdate(pageId: string, payload: YjsUpdatePayload) {
  const channel = yjsUpdateChannel(pageId);
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
  yjsUpdateChan: string;
  cleanup: () => Promise<void>;
}> {
  const client = await pool.connect();
  const awarenessChan = awarenessChannel(pageId);
  const revisionChan = revisionChannel(pageId);
  const yjsUpdateChan = yjsUpdateChannel(pageId);

  // pg-node doesn't interpolate identifiers safely in LISTEN, but these names
  // are built from a sanitized cuid so they're safe as raw SQL.
  await client.query(`LISTEN "${awarenessChan}"`);
  await client.query(`LISTEN "${revisionChan}"`);
  // Listened unconditionally (cheap -- an unused channel just never fires):
  // it only ever carries a message when a client with YJS_COLLAB enabled
  // posts an update, which the flag being off everywhere means never happens.
  await client.query(`LISTEN "${yjsUpdateChan}"`);

  const cleanup = async () => {
    try {
      await client.query(`UNLISTEN "${awarenessChan}"`);
      await client.query(`UNLISTEN "${revisionChan}"`);
      await client.query(`UNLISTEN "${yjsUpdateChan}"`);
    } catch {
      // best-effort
    }
    client.release();
  };

  return { client, awarenessChan, revisionChan, yjsUpdateChan, cleanup };
}

/**
 * The pool used for LISTEN/NOTIFY. Exposed so tests / health checks can
 * inspect the connection count; do NOT use this for regular queries.
 */
export const pubsubPool = pool;
