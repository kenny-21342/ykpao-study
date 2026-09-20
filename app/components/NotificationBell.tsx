'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTabActive } from './useTabActive';
import { useSession } from 'next-auth/react';
import { Bell, MessageSquare, Reply, AtSign, Loader2, X } from 'lucide-react';

type Actor = { id: string; name: string | null; image: string | null };

type Notification = {
  id: string;
  type: string;
  entityId: string | null;
  entityUrl: string | null;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
  actor: Actor | null;
};

// Map notification type → custom event name to dispatch when clicked.
// The SPA listens for these events and switches to the correct tab.
const CLICK_EVENTS: Record<string, { event: string; param?: string }> = {
  discussion_answer: { event: 'open-discussions' },
  discussion_reply: { event: 'open-discussions' },
  discussion_mention: { event: 'open-discussions' },
  note_invite: { event: 'open-notes' },
};

// Icon + tint per notification type. Falls back to a generic bell.
const TYPE_META: Record<string, { icon: typeof Bell; tint: string }> = {
  discussion_answer: { icon: MessageSquare, tint: 'bg-surface-raised text-secondary' },
  discussion_reply: { icon: Reply, tint: 'bg-accent-subtle text-accent-text' },
  discussion_mention: { icon: AtSign, tint: 'bg-surface-raised text-secondary' },
};

function fmtRelative(iso: string) {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function stripHtml(html: string): string {
  // Notifications may contain HTML (from announcement bodies, etc.).
  // Strip tags so the bell displays clean text.
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function normalizeNotificationUrl(url: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed.includes('#announcements')) return '/announcements';
  return trimmed;
}

export default function NotificationBell() {
  const { status } = useSession();
  const isAuthenticated = status === 'authenticated';
  // Hidden or abandoned tabs stop talking to the server entirely.
  const tabActive = useTabActive();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/notifications?limit=30');
      if (!res.ok) return;
      const data = await res.json();
      setNotifications(data.notifications ?? []);
      setUnreadCount(data.unreadCount ?? 0);
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load + light polling (every 30s) as a fallback behind SSE.
  // Gated on an authenticated session: signed-out visitors have no
  // notifications to fetch, and this was polling /api/notifications every 30
  // seconds and holding an SSE connection open for them regardless.
  //
  // Also gated on `tabActive`. A hidden or abandoned tab has nobody to show a
  // badge to, and this poll plus the SSE stream below were between them
  // keeping the database awake around the clock -- see `useTabActive` for
  // what that cost. Coming back re-runs the effect, so the first thing a
  // returning tab does is a fresh load.
  useEffect(() => {
    if (!isAuthenticated || !tabActive) return;
    const initialTimer = window.setTimeout(() => {
      void load();
    }, 0);
    const interval = window.setInterval(() => {
      void load();
    }, 30_000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [load, isAuthenticated, tabActive]);

  // Real-time updates via Server-Sent Events. The endpoint pushes an `unread`
  // event whenever the unread count changes. We trigger a light reload of the
  // list when the badge count changes so the dropdown stays fresh.
  useEffect(() => {
    if (!isAuthenticated || !tabActive) return;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let lastUnread: number | null = null;

    const connect = () => {
      try {
        es = new EventSource('/api/notifications/stream');
      } catch {
        return; // SSE unsupported — polling fallback still runs
      }
      es.addEventListener('unread', (e: MessageEvent) => {
        try {
          const { unreadCount } = JSON.parse(e.data) as { unreadCount: number };
          if (lastUnread !== null && unreadCount !== lastUnread) {
            // Refresh the list + badge in the background.
            load();
          }
          lastUnread = unreadCount;
          setUnreadCount(unreadCount);
        } catch {
          // ignore malformed payloads
        }
      });
      es.onerror = () => {
        // Browser will auto-reconnect, but if it gives up we retry after 5s.
        try { es?.close(); } catch { /* noop */ }
        reconnectTimer = setTimeout(connect, 5_000);
      };
    };
    connect();

    return () => {
      try { es?.close(); } catch { /* noop */ }
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [load, isAuthenticated, tabActive]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Reload when the dropdown is opened so the list is fresh.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, load]);

  const markOneRead = async (id: string) => {
    // Optimistic.
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch {
      // revert on failure is acceptable for best-effort UI
    }
  };

  const markAllRead = async () => {
    if (unreadCount === 0) return;
    setMarkingAll(true);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
    try {
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
    } finally {
      setMarkingAll(false);
    }
  };

  const onOpen = () => {
    setOpen((o) => !o);
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={onOpen}
        className="relative p-2.5 text-secondary hover:bg-surface-hover rounded-lg transition-all duration-200"
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-danger text-white text-[10px] font-bold rounded-full flex items-center justify-center ring-2 ring-white dark:ring-gray-800">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 mt-2 w-80 sm:w-96 bg-surface rounded-lg shadow-overlay border border-line z-50 flex flex-col max-h-[28rem] overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-subtle">
            <h3 className="text-sm font-bold text-primary">
              Notifications
              {unreadCount > 0 && (
                <span className="ml-2 text-xs font-medium text-muted">
                  {unreadCount} unread
                </span>
              )}
            </h3>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  disabled={markingAll}
                  className="text-xs font-medium text-accent-text hover:underline disabled:opacity-50"
                  title="Mark all as read" aria-label="Mark all as read"
                >
                  {markingAll ? 'Marking…' : 'Mark all read'}
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="md:hidden p-1 text-muted hover:text-secondary rounded-sm"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {loading && notifications.length === 0 ? (
              <div className="flex items-center justify-center py-10 text-muted">
                <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
              </div>
            ) : notifications.length === 0 ? (
              <div className="py-12 px-6 text-center">
                <Bell className="w-8 h-8 mx-auto text-muted mb-2" />
                <p className="text-sm font-medium text-muted">All caught up</p>
                <p className="text-xs text-muted mt-0.5">You have no notifications yet.</p>
              </div>
            ) : (
              <ul className="divide-y divide-subtle">
                {notifications.map((n) => {
                  const meta = TYPE_META[n.type] ?? { icon: Bell, tint: 'bg-surface-raised text-muted' };
                  const Icon = meta.icon;
                  const clickAction = CLICK_EVENTS[n.type];
                  return (
                    <li key={n.id}>
                      <a
                        href={normalizeNotificationUrl(n.entityUrl) ?? '#'}
                        onClick={(e) => {
                          if (!n.read) markOneRead(n.id);
                          // If this is a SPA-internal notification (discussions, notes),
                          // dispatch the event instead of navigating away.
                          if (clickAction && n.entityId) {
                            e.preventDefault();
                            window.dispatchEvent(new CustomEvent(clickAction.event, {
                              detail: { threadId: n.entityId, entityId: n.entityId },
                            }));
                            setOpen(false);
                          }
                        }}
                        className={`flex gap-3 px-4 py-3 hover:bg-surface-hover dark:hover:bg-gray-700/50 transition-colors ${
                          !n.read ? 'bg-accent-subtle' : ''
                        }`}
                      >
                        {/* Icon / avatar */}
                        <div className="flex-shrink-0">
                          {n.actor?.image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={n.actor.image} alt="" className="w-9 h-9 rounded-full object-cover" />
                          ) : (
                            <div className={`w-9 h-9 rounded-full flex items-center justify-center ${meta.tint}`}>
                              <Icon className="w-4 h-4" />
                            </div>
                          )}
                        </div>

                        {/* Body */}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-primary leading-snug">
                            {stripHtml(n.title)}
                          </p>
                          {n.body && (
                            <p className="text-xs text-muted mt-0.5 line-clamp-2">
                              {stripHtml(n.body)}
                            </p>
                          )}
                          <p className="text-[11px] text-muted mt-1">{fmtRelative(n.createdAt)}</p>
                        </div>

                        {/* Unread dot */}
                        {!n.read && (
                          <span
                            className="mt-1 w-2 h-2 bg-accent rounded-full flex-shrink-0"
                            aria-label="Unread"
                          />
                        )}
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Footer */}
          {notifications.length > 0 && (
            <div className="px-4 py-2 border-t border-subtle text-center">
              <button
                onClick={() => {
                  setOpen(false);
                  // Hand off to the host page via a custom event so the host
                  // can route to its discussions tab without tight coupling.
                  window.dispatchEvent(new CustomEvent('open-discussions'));
                }}
                className="text-xs font-medium text-muted hover:text-secondary"
              >
                Go to discussions
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
