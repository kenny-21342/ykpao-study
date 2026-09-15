'use client';

import { useState, useEffect } from 'react';
import { Megaphone, Loader2, Pin, ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import SessionProvider from '../components/SessionProvider';
import ThemeToggle from '../components/ThemeToggle';
import { sanitizeHtml } from '@/lib/sanitize-html';

type Announcement = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  author?: { name: string | null };
};

export default function AnnouncementsPage() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/announcements?all=true')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.announcements) setAnnouncements(data.announcements);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <SessionProvider>
      <div className="min-h-screen bg-canvas">
        {/* Top bar */}
        <header className="bg-white/60 dark:bg-gray-900/40 backdrop-blur-2xl border-b border-white/30 dark:border-white/10 px-6 py-4 flex items-center justify-between">
          <Link href="/" className="inline-flex items-center gap-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-green-600 transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </Link>
          <ThemeToggle />
        </header>

        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
          {/* Header */}
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-lg bg-accent flex items-center justify-center">
              <Megaphone className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Announcements</h1>
              <p className="text-sm text-gray-500 dark:text-gray-400">All platform updates and notices</p>
            </div>
          </div>

          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-8 h-8 animate-spin text-green-500" />
            </div>
          )}

          {/* Empty. Brought up to the standard set by ResourceLibrary: a
              heading that says what is missing, and a line that says what
              happens next -- rather than a single grey sentence that reads
              like something failed. */}
          {!loading && announcements.length === 0 && (
            <div className="rounded-lg border border-dashed border-gray-300 bg-white p-12 text-center dark:border-gray-600 dark:bg-gray-800">
              <Megaphone className="mx-auto mb-3 h-12 w-12 text-gray-300 dark:text-gray-600" />
              <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">
                Nothing announced yet
              </h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Notices from your teachers and admins appear here, and in the bell at the top
                of the app.
              </p>
            </div>
          )}

          {/* Announcement cards */}
          {announcements.map((a) => (
            <article
              key={a.id}
              className={`min-w-0 rounded-lg p-6 border ${
                a.pinned
                  ? 'bg-accent-subtle border-green-200 dark:border-green-900/50'
                  : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700'
              }`}
            >
              <div className="flex items-center gap-2 mb-3">
                {a.pinned && (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300">
                    <Pin className="w-3 h-3" /> Pinned
                  </span>
                )}
                <span className="text-xs text-gray-400">
                  {new Date(a.createdAt).toLocaleDateString(undefined, {
                    month: 'long', day: 'numeric', year: 'numeric',
                  })}
                </span>
                {a.author?.name && (
                  <span className="text-xs text-gray-400">· {a.author.name}</span>
                )}
              </div>
              <h2 className="mb-2 break-words text-lg font-bold text-gray-900 dark:text-gray-100">
                {a.title}
              </h2>
              <div
                className="max-w-none break-words text-sm text-gray-700 dark:text-gray-300 prose prose-sm dark:prose-invert
                  [&_a]:break-words [&_a]:text-green-600 [&_a]:underline [&_img]:max-w-full
                  [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(a.body) }}
              />
            </article>
          ))}
        </div>
      </div>
    </SessionProvider>
  );
}
