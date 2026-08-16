'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

/**
 * Awareness state for a single remote user on the same page.
 */
export type RemoteAwareness = {
  userId: string;
  userName: string | null;
  userImage: string | null;
  userColor: string;
  cursorFrom: number | null;
  cursorTo: number | null;
  typing: boolean;
};

/**
 * usePageCollaboration — SSE client for real-time collaborative editing awareness.
 *
 * Connects to `/api/pages/[id]/stream` via EventSource and exposes:
 *   - `others`: list of remote editors currently on the page (excluding self)
 *   - `revision`: the latest known content revision (bumps when someone saves)
 *   - `postCursor`: throttled cursor-position broadcaster
 *   - `postTyping`: typing-indicator broadcaster
 *
 * The hook is intentionally awareness-only — actual content editing still
 * goes through the existing debounced-autosave + revision-409 flow.
 *
 * Auto-reconnects on disconnect (EventSource handles this natively). After
 * the server's 10-minute max lifetime, the stream closes and EventSource
 * reconnects within ~3s.
 */
/**
 * How many consecutive failed connections (with no successful `hello` in
 * between) before we stop trying to open the collaboration stream.
 */
const MAX_CONSECUTIVE_FAILURES = 4;

export function usePageCollaboration(
  pageId: string | null | undefined,
  self: { id: string; name?: string | null; image?: string | null } | null | undefined,
  onRevision?: (revision: number, savedBy: string) => void
) {
  const [others, setOthers] = useState<Map<string, RemoteAwareness>>(new Map());
  const [revision, setRevision] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  // Refs to the latest values so the SSE handlers don't capture stale closures.
  const selfIdRef = useRef<string | null>(null);
  const onRevisionRef = useRef(onRevision);

  useEffect(() => {
    selfIdRef.current = self?.id ?? null;
  }, [self?.id]);

  useEffect(() => {
    onRevisionRef.current = onRevision;
  }, [onRevision]);

  useEffect(() => {
    if (!pageId || !self?.id) return;

    const es = new EventSource(`/api/pages/${pageId}/stream`, { withCredentials: true });
    esRef.current = es;
    // Consecutive connection failures with no successful handshake between.
    let failedAttempts = 0;

    const upsertOther = (data: RemoteAwareness) => {
      if (data.userId === selfIdRef.current) return; // skip self
      setOthers((prev) => {
        const next = new Map(prev);
        next.set(data.userId, data);
        return next;
      });
    };

    es.addEventListener('hello', () => {
      // A completed handshake means the endpoint works; forget earlier
      // failures so a normal max-age reconnect doesn't count toward giving up.
      failedAttempts = 0;
      setConnected(true);
    });

    es.addEventListener('presence', (e) => {
      try {
        const list: RemoteAwareness[] = JSON.parse((e as MessageEvent).data);
        setOthers(() => {
          const next = new Map<string, RemoteAwareness>();
          for (const p of list) {
            if (p.userId !== selfIdRef.current) next.set(p.userId, p);
          }
          return next;
        });
      } catch {
        // malformed payload
      }
    });

    es.addEventListener('cursor', (e) => {
      try {
        upsertOther(JSON.parse((e as MessageEvent).data));
      } catch {
        // malformed payload
      }
    });

    es.addEventListener('leave', (e) => {
      try {
        const { userId } = JSON.parse((e as MessageEvent).data);
        setOthers((prev) => {
          if (!prev.has(userId)) return prev;
          const next = new Map(prev);
          next.delete(userId);
          return next;
        });
      } catch {
        // malformed
      }
    });

    es.addEventListener('revision', (e) => {
      try {
        const { revision: rev, savedBy } = JSON.parse((e as MessageEvent).data);
        setRevision(rev);
        onRevisionRef.current?.(rev, savedBy);
      } catch {
        // malformed
      }
    });

    es.addEventListener('end', () => {
      // Server will close; EventSource auto-reconnects.
      setConnected(false);
    });

    es.onerror = () => {
      setConnected(false);
      failedAttempts += 1;
      // EventSource retries forever and cannot see the HTTP status, so a
      // deployment where realtime is unavailable (the endpoint answers 501,
      // or LISTEN can't work) would otherwise reconnect in a loop for as long
      // as the page stays open. Give up after a few consecutive failures with
      // no successful handshake in between; the editor still works, it just
      // stops showing other people's cursors.
      if (failedAttempts >= MAX_CONSECUTIVE_FAILURES) {
        es.close();
        esRef.current = null;
      }
    };

    return () => {
      es.close();
      esRef.current = null;
      setConnected(false);
      setOthers(new Map());
    };
  }, [pageId, self?.id]);

  // --- Cursor broadcaster (throttled to 5 msgs/sec) -------------------------
  const lastCursorPost = useRef(0);
  const pendingCursor = useRef<{ from: number | null; to: number | null } | null>(null);

  const postCursor = useCallback(
    (from: number | null, to: number | null) => {
      if (!pageId) return;
      pendingCursor.current = { from, to };
      const now = Date.now();
      if (now - lastCursorPost.current < 200) return; // throttle
      lastCursorPost.current = now;

      const payload = pendingCursor.current;
      pendingCursor.current = null;
      void fetch(`/api/pages/${pageId}/awareness`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursorFrom: payload.from, cursorTo: payload.to }),
      }).catch(() => {
        // best-effort
      });
    },
    [pageId]
  );

  // Flush any pending cursor on unmount so the final position is recorded.
  useEffect(() => {
    return () => {
      if (pendingCursor.current && pageId) {
        void fetch(`/api/pages/${pageId}/awareness`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cursorFrom: pendingCursor.current.from, cursorTo: pendingCursor.current.to }),
        }).catch(() => {});
      }
    };
  }, [pageId]);

  // --- Typing indicator -----------------------------------------------------
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const postTyping = useCallback(
    (typing: boolean) => {
      if (!pageId) return;
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      // Auto-clear typing after 3s of no keystrokes.
      if (typing) {
        typingTimeout.current = setTimeout(() => {
          void fetch(`/api/pages/${pageId}/awareness`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ typing: false }),
          }).catch(() => {});
        }, 3000);
      }
      void fetch(`/api/pages/${pageId}/awareness`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ typing }),
      }).catch(() => {});
    },
    [pageId]
  );

  const othersList = useMemo(() => Array.from(others.values()), [others]);

  return { others: othersList, othersMap: others, revision, connected, postCursor, postTyping };
}
