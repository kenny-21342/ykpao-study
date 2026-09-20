import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { streamLifetimeMs } from '@/lib/stream-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Must exceed SSE_MAX_LIFETIME_MS (50s by default in lib/stream-config.ts) or the platform kills the
 * stream before the server closes it cleanly, and every client reconnects
 * through an error path on a fixed cycle forever. Lower SSE_MAX_LIFETIME_MS
 * rather than raising this past what your plan allows.
 */
export const maxDuration = 300;

/**
 * GET /api/notifications/stream
 *
 * Server-Sent Events endpoint that pushes a "ping" with the current unread
 * count whenever it changes. This lets the NotificationBell badge update in
 * real time without full polling.
 *
 * We use a lightweight DB poll on the server rather than a separate pubsub
 * infra — sufficient for an education app's traffic and keeps the deployment
 * story simple (works with SQLite or Postgres, no Redis).
 *
 * The poll *backs off* while nothing is happening: 15s, then doubling to a
 * 2-minute ceiling, resetting to 15s the moment the count changes. A student
 * who is actually receiving notifications still sees the badge move within
 * 15s; a stream with nothing to say costs one query every two minutes
 * instead of four a minute.
 *
 * That is not a micro-optimisation. A serverless Postgres suspends its
 * compute after ~5 minutes of inactivity, so a fixed 15s poll means the
 * database can never reach idle for as long as one tab is open anywhere.
 * That is exactly what happened on 19 Sep 2026: the compute stayed awake for
 * ten days, exhausted the month's allowance with eleven days to go, and
 * production went down. The client half of the fix is `useTabActive`, which
 * drops this connection entirely once a tab is hidden or abandoned.
 *
 * The connection auto-closes after ~10 minutes so clients reconnect and pick
 * up fresh session cookies.
 */
export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let lastUnread: number | null = null;
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch {
          // controller already closed
        }
      };

      // Initial hello so the client knows the stream is alive.
      send('hello', { ts: Date.now() });

      // Backoff bounds. `MIN` is what an active conversation gets; `MAX` is
      // what an open-but-silent tab settles at.
      const POLL_MIN_MS = 15_000;
      const POLL_MAX_MS = 120_000;
      let pollMs = POLL_MIN_MS;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;

      const poll = async () => {
        if (closed) return;
        try {
          const unreadCount = await prisma.notification.count({
            where: { userId: user.id, read: false },
          });
          if (unreadCount !== lastUnread) {
            lastUnread = unreadCount;
            send('unread', { unreadCount });
            // Something is happening — go back to being responsive.
            pollMs = POLL_MIN_MS;
          } else {
            pollMs = Math.min(pollMs * 2, POLL_MAX_MS);
          }
        } catch {
          // best-effort; next tick will retry. A failed query says nothing
          // about how busy the user is, so the interval is left alone.
        }
        if (!closed) pollTimer = setTimeout(poll, pollMs);
      };

      void poll();

      // Heartbeat every 25s to keep proxies from closing idle connections.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          // closed
        }
      }, 25_000);

      // Safety: close before the platform's function timeout so the client
      // reconnects on the normal path rather than through an error.
      const maxLifetime = setTimeout(() => {
        send('end', { reason: 'max-age' });
        cleanup();
      }, streamLifetimeMs());

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearTimeout(pollTimer);
        clearInterval(heartbeat);
        clearTimeout(maxLifetime);
        try {
          req.signal.removeEventListener('abort', onAbort);
        } catch {
          // ignore
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const onAbort = () => cleanup();
      req.signal.addEventListener('abort', onAbort);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering
    },
  });
}
