'use client';

/**
 * Cmd+K global search palette, mounted inside AppSidebar (the one component
 * that renders across the whole app shell — see AppSidebar.tsx's own comment
 * on why). Routes outside the shell that don't render AppSidebar at all
 * (`/papers/[id]`, `/notes`, `/textbook`, `/practice`, `/usage`) don't get
 * this palette either — a documented v1 gap, not an oversight: wiring a
 * root-layout-level palette is a larger change than this plan's timeline
 * allows for, since `app/layout.tsx` is deliberately kept minimal.
 *
 * Navigation on a result click is a full page load (`window.location.href`)
 * rather than calling the shell's in-place `onNavigate`: results carry a
 * `/?tab=...` URL that already works as a plain link (the shell reads that
 * query param on mount), and a full load is the one navigation strategy that
 * works identically whether the palette is open inside the shell or on a
 * route outside it.
 */

import { useEffect, useRef, useState } from 'react';
import { Search, X, Loader2 } from 'lucide-react';

type SearchResult = {
  id: string;
  type: 'question' | 'markscheme' | 'note' | 'textbook' | 'resource' | 'announcement' | 'discussion' | 'syllabus';
  title: string;
  snippet: string;
  url: string;
  subject?: string | null;
  topic?: string | null;
};

const TYPE_LABEL: Record<SearchResult['type'], string> = {
  question: 'Question',
  markscheme: 'Mark Scheme',
  note: 'Note',
  textbook: 'Textbook',
  resource: 'Resource',
  announcement: 'Announcement',
  discussion: 'Discussion',
  syllabus: 'Past Paper',
};

export default function GlobalSearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery('');
      setResults([]);
      setError(null);
      // Let the modal mount before focusing, or the ref is still null.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const t = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        if (!res.ok) throw new Error('Search failed');
        const data = await res.json();
        setResults(data.results ?? []);
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return;
        setError('Search failed. Try again.');
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      controller.abort();
      window.clearTimeout(t);
    };
  }, [open, query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 px-4 pt-24" onClick={onClose}>
      <div
        className="w-full max-w-xl rounded-2xl bg-white shadow-2xl dark:bg-gray-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-gray-100 px-4 py-3 dark:border-gray-800">
          <Search className="h-5 w-5 flex-shrink-0 text-gray-400" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes, questions, resources, discussions…"
            className="flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-100"
          />
          {loading && <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-gray-400" />}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="flex-shrink-0 rounded-lg p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {error && <p className="px-3 py-4 text-sm text-red-500">{error}</p>}
          {!error && !loading && query.trim().length >= 2 && results.length === 0 && (
            <p className="px-3 py-4 text-sm text-gray-500">No results for &ldquo;{query.trim()}&rdquo;.</p>
          )}
          {!error && query.trim().length < 2 && (
            <p className="px-3 py-4 text-sm text-gray-400">Type at least 2 characters to search.</p>
          )}
          {results.map((result) => (
            <a
              key={result.id}
              href={result.url}
              onClick={onClose}
              className="block rounded-xl px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              <div className="flex items-center gap-2">
                <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                  {TYPE_LABEL[result.type]}
                </span>
                <span className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{result.title}</span>
              </div>
              {result.snippet && (
                <p className="mt-0.5 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{result.snippet}</p>
              )}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
