'use client';

import { useCallback, useEffect, useState } from 'react';
import { Trash2, Search, Download, FileText } from 'lucide-react';
import { adminFetch } from '../lib/fetch';
import { LoadingSpinner, ErrorBox } from './AdminDashboard';
import { useDebouncedValue } from '../../components/useDebouncedValue';

type Resource = {
  id: string;
  title: string;
  description: string | null;
  subject: string | null;
  category: string | null;
  fileUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  downloads: number;
  createdAt: string;
  uploader: { name: string | null; email: string };
};

type Response = { items: Resource[]; total: number; totalPages: number };

export default function ResourceManager() {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  // Debounced so typing a query fires one request, not one per keystroke.
  const debouncedQ = useDebouncedValue(q, 300);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ type: 'resources', page: String(page) });
      if (debouncedQ) params.set('q', debouncedQ);
      const res = await adminFetch<Response>(`/api/admin/content?${params}`);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [debouncedQ, page]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  const remove = async (id: string) => {
    if (!confirm('Delete this resource permanently?')) return;
    try {
      await adminFetch(`/api/admin/content?type=resources&id=${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <header>
        <h1 className="text-2xl font-bold">School Resources</h1>
        <p className="text-sm text-gray-500 mt-1">Manage staff-uploaded public learning materials.</p>
        <p className="text-xs text-indigo-500 mt-1">To add new resources, use the &ldquo;Resource Library&rdquo; tab in the main app (staff upload form).</p>
      </header>

      {error && <ErrorBox message={error} />}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input type="text" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="e.g. worksheet, 2024, or Ms Lee" className="w-full pl-9 pr-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none" />
      </div>

      {/* Only show the spinner before the first result set arrives. Swapping
          the table out on every refetch made the list flash and jump while the
          search box was still being typed into. */}
      {loading && !data ? <LoadingSpinner /> : data && (
        <div className="space-y-3">
          {data.items.length === 0 ? (
            <p className="text-sm text-gray-400 italic py-8 text-center">No resources found.</p>
          ) : (
            data.items.map((r) => (
              <div key={r.id} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 flex items-start gap-3">
                <div className="w-10 h-10 bg-gray-100 dark:bg-gray-800 rounded-lg flex items-center justify-center flex-shrink-0">
                  <FileText className="w-5 h-5 text-gray-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium text-sm truncate">{r.title}</h3>
                  {r.description && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{r.description}</p>}
                  <p className="text-xs text-gray-400 mt-1">
                    {r.category && <span className="mr-2">{r.category}</span>}
                    {r.subject && <span className="mr-2">· {r.subject}</span>}
                    · {(r.fileSize / 1024 / 1024).toFixed(1)} MB
                    · {r.downloads} downloads
                  </p>
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    by {r.uploader?.name ?? r.uploader?.email} · {new Date(r.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <a href={r.fileUrl} download className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800" title="Download">
                    <Download className="w-4 h-4" />
                  </a>
                  <button onClick={() => remove(r.id)} title="Delete" className="p-1.5 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
