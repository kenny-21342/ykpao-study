'use client';

import { useState, useEffect } from 'react';
import { Megaphone, Pin, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { sanitizeHtml } from '@/lib/sanitize-html';

type Announcement = {
  id: string;
  title: string;
  body: string;
  published: boolean;
  pinned: boolean;
  createdAt: string;
};

/**
 * Renders published announcements on the dashboard.
 * Pinned announcements show first.
 */
export default function AnnouncementBanner() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/announcements')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.announcements) setAnnouncements(data.announcements);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Load dismissed IDs from sessionStorage so dismissed announcements
  // don't reappear within the session.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const raw = sessionStorage.getItem('dismissed-announcements');
        if (raw) setDismissed(new Set(JSON.parse(raw)));
      } catch {
        // ignore
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const dismiss = (id: string) => {
    const next = new Set(dismissed);
    next.add(id);
    setDismissed(next);
    try {
      sessionStorage.setItem('dismissed-announcements', JSON.stringify([...next]));
    } catch {
      // ignore
    }
  };

  if (loading) {
    return null; // don't show a spinner for the banner — just appear when ready
  }

  const visible = announcements.filter((a) => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  return (
    <div id="announcements" className="space-y-3">
      {visible.slice(0, 3).map((a) => (
        <div
          key={a.id}
          className={`floating-panel rounded-2xl p-4 border shadow-sm ${
            a.pinned
              ? 'bg-accent-subtle dark:from-green-950/30 dark:to-emerald-950/30 border-green-200 dark:border-green-900/50'
              : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700'
          }`}
        >
          <div className="flex items-start gap-3">
            <div className={`flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center ${
              a.pinned ? 'bg-green-500' : 'bg-gray-400'
            }`}>
              {a.pinned ? <Pin className="w-4 h-4 text-white" /> : <Megaphone className="w-4 h-4 text-white" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <h4 className="min-w-0 pr-2 text-sm font-bold leading-snug break-words text-gray-900 dark:text-gray-100">
                  {a.title}
                </h4>
                <button
                  onClick={() => dismiss(a.id)}
                  className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xs flex-shrink-0"
                  title="Dismiss" aria-label="Dismiss"
                >
                  ✕
                </button>
              </div>
              <div
                className="mt-1 break-words text-sm text-gray-600 dark:text-gray-400 prose-sm max-w-none [&_p]:my-1 [&_a]:break-words [&_a]:text-green-600 [&_a]:underline [&_img]:max-w-full"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(a.body) }}
              />
              <p className="text-[10px] text-gray-400 mt-1.5">
                {new Date(a.createdAt).toLocaleDateString(undefined, {
                  month: 'short', day: 'numeric', year: 'numeric',
                })}
              </p>
            </div>
          </div>
        </div>
      ))}
      {visible.length > 3 && (
        <Link
          href="/announcements"
          className="inline-flex items-center gap-1 text-sm text-green-600 dark:text-green-400 hover:underline font-medium"
        >
          View all {visible.length} announcements
          <ChevronRight className="w-3.5 h-3.5" />
        </Link>
      )}
      {visible.length > 0 && visible.length <= 3 && (
        <Link
          href="/announcements"
          className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        >
          All announcements
          <ChevronRight className="w-3 h-3" />
        </Link>
      )}
    </div>
  );
}
