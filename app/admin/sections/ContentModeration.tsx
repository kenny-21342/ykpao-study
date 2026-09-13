'use client';

import { useCallback, useEffect, useState } from 'react';
import { Search, Trash2, Pin, PinOff, Lock, LockOpen, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { useConfirm } from '../../components/useConfirm';
import { adminFetch } from '../lib/fetch';
import { LoadingSpinner, ErrorBox } from './AdminDashboard';
import { useDebouncedValue } from '../../components/useDebouncedValue';

type ContentType = 'threads' | 'posts' | 'resources';

type ContentItem = {
  id: string;
  title?: string;
  content?: string;
  description?: string;
  createdAt: string;
  pinned?: boolean;
  locked?: boolean;
  views?: number;
  downloads?: number;
  author?: { name: string | null; email: string };
  user?: { name: string | null; email: string };
  uploader?: { name: string | null; email: string };
  thread?: { id: string; title: string };
  _count?: { posts: number };
};

type Response = { items: ContentItem[]; total: number; page: number; pageSize: number; totalPages: number };

const TABS: { key: ContentType; label: string }[] = [
  { key: 'threads', label: 'Threads' },
  { key: 'posts', label: 'Posts' },
  { key: 'resources', label: 'School Resources' },
];

export default function ContentModeration() {
  const { confirm, confirmDialog } = useConfirm();
  const [type, setType] = useState<ContentType>('threads');
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  // Debounced so typing a query fires one request, not one per keystroke.
  const debouncedQ = useDebouncedValue(q, 300);
  const [page, setPage] = useState(1);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ type, page: String(page) });
      if (debouncedQ) params.set('q', debouncedQ);
      const res = await adminFetch<Response>(`/api/admin/content?${params}`);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [type, page, debouncedQ]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  const remove = async (id: string) => {
    const ok = await confirm({
      title: 'Delete this permanently?',
      message:
        'This removes another person\u2019s content for good \u2014 they are not told, and it cannot be undone.',
      confirmLabel: 'Delete permanently',
    });
    if (!ok) return;
    setActionLoading(id);
    try {
      await adminFetch(`/api/admin/content?type=${type}&id=${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setActionLoading(null);
    }
  };

  const patchThread = async (id: string, action: string) => {
    setActionLoading(id + action);
    try {
      await adminFetch('/api/admin/content', { method: 'PATCH', body: JSON.stringify({ type: 'threads', id, action }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {confirmDialog}
      <header>
        <h1 className="text-2xl font-bold">Content Moderation</h1>
        <p className="text-sm text-gray-500 mt-1">Review and moderate all user-generated content.</p>
      </header>

      {error && <ErrorBox message={error} />}

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setType(t.key); setPage(1); setQ(''); }}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              type === t.key
                ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          type="text"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          placeholder="e.g. spam report, calculus thread, or @maria"
          className="w-full pl-9 pr-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
        />
      </div>

      {/* Only show the spinner before the first result set arrives. Swapping
          the table out on every refetch made the list flash and jump while the
          search box was still being typed into. */}
      {loading && !data ? <LoadingSpinner /> : data && (
        <>
          <div className="space-y-3">
            {data.items.length === 0 ? (
              <p className="text-sm text-gray-400 italic py-8 text-center">No content found.</p>
            ) : (
              data.items.map((item) => {
                const author = item.author ?? item.user ?? item.uploader;
                const preview = item.title ?? item.content ?? item.description ?? '(no text)';
                return (
                  <div key={item.id} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          {item.pinned && <span className="text-[10px] px-1.5 py-0.5 bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 rounded">PINNED</span>}
                          {item.locked && <span className="text-[10px] px-1.5 py-0.5 bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 rounded">LOCKED</span>}
                          <span className="text-xs text-gray-400">{new Date(item.createdAt).toLocaleString()}</span>
                        </div>
                        <p className="text-sm font-medium line-clamp-2">{preview}</p>
                        <p className="text-xs text-gray-400 mt-1">
                          by {author?.name ?? author?.email ?? 'Unknown'}
                          {item.thread && <> · in <span className="text-indigo-500">{item.thread.title}</span></>}
                          {item._count && <> · {item._count.posts} replies</>}
                          {item.views != null && <> · {item.views} views</>}
                          {item.downloads != null && <> · {item.downloads} downloads</>}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {type === 'threads' && (
                          <>
                            <button
                              onClick={() => patchThread(item.id, item.pinned ? 'unpin' : 'pin')}
                              disabled={actionLoading === item.id + (item.pinned ? 'unpin' : 'pin')}
                              title={item.pinned ? 'Unpin' : 'Pin'}
                              className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                            >
                              {item.pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
                            </button>
                            <button
                              onClick={() => patchThread(item.id, item.locked ? 'unlock' : 'lock')}
                              disabled={actionLoading === item.id + (item.locked ? 'unlock' : 'lock')}
                              title={item.locked ? 'Unlock' : 'Lock'}
                              className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                            >
                              {item.locked ? <LockOpen className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => remove(item.id)}
                          disabled={actionLoading === item.id}
                          title="Delete" aria-label="Delete"
                          className="p-1.5 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-30"
                        >
                          {actionLoading === item.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {data.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-gray-500">Page {data.page} of {data.totalPages} · {data.total} items</p>
              <div className="flex gap-1">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="p-2 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-30">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))} disabled={page >= data.totalPages} className="p-2 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-30">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
