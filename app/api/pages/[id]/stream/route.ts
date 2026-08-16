import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getPageAccess } from '@/lib/page-access';
import { listenToPage } from '@/lib/page-pubsub';
import { isRealtimeCollabEnabled, streamLifetimeMs } from '@/lib/stream-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Must exceed SSE_MAX_LIFETIME_MS (240s by default) or the platform kills the
 * stream before the server closes it cleanly, and every client reconnects
 * through an error path on a fixed cycle forever. Lower SSE_MAX_LIFETIME_MS
 * rather than raising this past what your plan allows.
 */
export const maxDuration = 300;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/pages/[id]/stream
 *
 * Server-Sent Events endpoint for real-time collaborative editing awareness.
 * Pushes three event types:
 *   - `presence`  — who's currently on the page (initial snapshot + joins/leaves)
 *   - `cursor`    — remote cursor position / typing indicator updates
 *   - `revision`  — content revision bumps (triggers auto-refresh on other clients)
 *
 * Backed by Postgres LISTEN/NOTIFY so it works across multiple serverless
 * instances without an external pub/sub service. Each connection holds a
 * dedicated pg client for the lifetime of the stream (released on disconnect).
 *
 * Auto-closes after 10 min so clients reconnect with fresh session cookies,
 * mirroring the pattern in /api/notifications/stream.
 */
export async function GET(_req: Request, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Where LISTEN/NOTIFY cannot work (a pooled-only connection string, say),
  // say so immediately instead of holding open a stream that will never
  // deliver an event. The client treats this as "collaboration unavailable"
  // and stops retrying, rather than reconnecting forever.
  if (!isRealtimeCollabEnabled()) {
    return new Response('Realtime collaboration is disabled', {
      status: 501,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const { id: pageId } = await params;
  const access = await getPageAccess(pageId, user.id);
  if (!access) {
    return new Response('Page not found', { status: 404 });
  }

  // Assign a stable-ish color per user for cursor decoration.
  const userColor = pickUserColor(user.id);

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
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

      // --- Register our own presence --------------------------------------
      // Upsert awareness row so the initial presence snapshot below includes us.
      const now = new Date();
      try {
        await prisma.pageAwareness.upsert({
          where: { pageId_userId: { pageId, userId: user.id } },
          create: { pageId, userId: user.id, lastSeenAt: now },
          update: { lastSeenAt: now, typing: false },
        });
      } catch {
        // best-effort — the SSE stream still works without DB presence
      }

      // --- Initial snapshot: who's here right now? ------------------------
      try {
        const activeAfter = new Date(Date.now() - 2 * 60_000);
        const present = await prisma.pageAwareness.findMany({
          where: { pageId, lastSeenAt: { gte: activeAfter } },
          include: {
            user: { select: { id: true, name: true, image: true } },
          },
        });
        send(
          'presence',
          present.map((p) => ({
            userId: p.user.id,
            userName: p.user.name,
            userImage: p.user.image,
            userColor: pickUserColor(p.user.id),
            cursorFrom: p.cursorFrom,
            cursorTo: p.cursorTo,
            typing: p.typing,
          }))
        );
      } catch {
        // best-effort
      }

      send('hello', { userId: user.id, userColor });

      // --- Subscribe to Postgres NOTIFY -----------------------------------
      let cleanup: (() => Promise<void>) | null = null;
      try {
        const sub = await listenToPage(pageId);
        cleanup = sub.cleanup;

        sub.client.on('notification', (msg) => {
          if (closed || !msg.payload) return;
          try {
            const payload = JSON.parse(msg.payload);
            // Map the channel back to an SSE event type.
            if (msg.channel === sub.revisionChan) {
              send('revision', payload);
            } else {
              // Awareness channel — distinguish join/leave from cursor moves.
              if (payload.left) {
                send('leave', { userId: payload.userId });
              } else {
                send('cursor', payload);
              }
            }
          } catch {
            // malformed payload — ignore
          }
        });
      } catch (err) {
        console.error('[page-stream] LISTEN failed, falling back to poll:', err);
        // Fallback: poll awareness every 5s. Less efficient but keeps the
        // stream functional if the dedicated pg client can't be acquired.
        const pollInterval = setInterval(async () => {
          if (closed) return;
          try {
            const activeAfter = new Date(Date.now() - 2 * 60_000);
            const present = await prisma.pageAwareness.findMany({
              where: { pageId, lastSeenAt: { gte: activeAfter } },
              include: { user: { select: { id: true, name: true, image: true } } },
            });
            send(
              'presence',
              present.map((p) => ({
                userId: p.user.id,
                userName: p.user.name,
                userImage: p.user.image,
                userColor: pickUserColor(p.user.id),
                cursorFrom: p.cursorFrom,
                cursorTo: p.cursorTo,
                typing: p.typing,
              }))
            );
          } catch {
            // best-effort
          }
        }, 5_000);

        // Replace cleanup with interval clearer.
        const oldCleanup = cleanup;
        cleanup = async () => {
          clearInterval(pollInterval);
          if (oldCleanup) await oldCleanup();
        };
      }

      // --- Heartbeat to keep proxies happy --------------------------------
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          // closed
        }
      }, 25_000);

      // --- Periodic presence refresh (every 5 min) ------------------------
      // Keeps our awareness row fresh even if the tab is idle.
      const presenceTick = setInterval(async () => {
        if (closed) return;
        try {
          await prisma.pageAwareness.update({
            where: { pageId_userId: { pageId, userId: user.id } },
            data: { lastSeenAt: new Date() },
          });
        } catch {
          // best-effort
        }
      }, 5 * 60_000);

      // --- Safety: close before the platform kills the invocation ---------
      const maxLifetime = setTimeout(() => {
        send('end', { reason: 'max-age' });
        void cleanupAll();
      }, streamLifetimeMs());

      const cleanupAll = async () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearInterval(presenceTick);
        clearTimeout(maxLifetime);
        try {
          _req.signal.removeEventListener('abort', onAbort);
        } catch {
          // ignore
        }
        // Mark our awareness as stale (lastSeenAt left at the last heartbeat;
        // the 2-min TTL will naturally evict us from others' presence lists).
        try {
          await prisma.pageAwareness.update({
            where: { pageId_userId: { pageId, userId: user.id } },
            data: { typing: false, cursorFrom: null, cursorTo: null },
          });
        } catch {
          // best-effort
        }
        if (cleanup) {
          try {
            await cleanup();
          } catch {
            // ignore
          }
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const onAbort = () => void cleanupAll();
      _req.signal.addEventListener('abort', onAbort);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * Deterministically pick a high-contrast color for a user's cursor decoration.
 * Same userId → same color, across sessions and devices.
 */
const CURSOR_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
];

function pickUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}
