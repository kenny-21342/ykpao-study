'use client';

import { useState, useEffect } from 'react';
import { BookOpen, Star, MessageSquare, ArrowRight } from 'lucide-react';

type TrendingNote = {
  id: string;
  title: string;
  subject: string | null;
  tags: string[];
  author: { id: string; name: string | null; image: string | null };
  commentCount: number;
  ratingCount: number;
};

/**
 * Compact "trending community notes" card for the dashboard sidebar.
 * Shows the 4 most recently published community notes so students discover
 * the shared-notes library without having to navigate to Materials → Library.
 */
export default function TrendingNotes() {
  const [notes, setNotes] = useState<TrendingNote[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/shared-notes?limit=4')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.notes) {
          setNotes(data.notes);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const openMaterials = () => {
    window.dispatchEvent(new CustomEvent('ai-navigate', { detail: { tab: 'materials' } }));
  };

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Community notes</h2>
        <button
          onClick={openMaterials}
          className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 dark:text-emerald-400 inline-flex items-center gap-1"
        >
          Browse all <ArrowRight className="h-3 w-3" />
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
          ))}
        </div>
      ) : notes.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 py-4 text-center">
          No community notes yet. Be the first to share!
        </p>
      ) : (
        <div className="space-y-2">
          {notes.map((note) => (
            <button
              key={note.id}
              onClick={openMaterials}
              className="w-full flex items-start gap-3 p-2.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left"
            >
              <div className="w-9 h-9 grid place-items-center bg-emerald-50 dark:bg-emerald-950/30 rounded-lg flex-shrink-0">
                <BookOpen className="w-4 h-4 text-emerald-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 line-clamp-1">{note.title}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  {note.subject && (
                    <span className="text-[10px] font-medium text-gray-500 dark:text-gray-400">{note.subject}</span>
                  )}
                  <span className="flex items-center gap-0.5 text-[10px] text-gray-400">
                    <Star className="w-2.5 h-2.5" /> {note.ratingCount}
                  </span>
                  <span className="flex items-center gap-0.5 text-[10px] text-gray-400">
                    <MessageSquare className="w-2.5 h-2.5" /> {note.commentCount}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
