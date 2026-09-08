'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Trash2, Search, Download, FileText, Upload, X, Loader2, Paperclip, FolderUp,
  CheckCircle2, XCircle, Plus, Pencil, File as FileIcon, TriangleAlert,
} from 'lucide-react';
import { adminFetch } from '../lib/fetch';
import { LoadingSpinner, ErrorBox } from './AdminDashboard';
import { useDebouncedValue } from '../../components/useDebouncedValue';
import {
  ALLOWED_RESOURCE_EXTS,
  RESOURCE_UPLOAD_MAX_BYTES,
  isHiddenUploadSegment,
} from '@/lib/upload-constants';

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

// Must stay in sync with /api/upload's allow-list — both read
// lib/upload-constants.ts, so drift breaks the build, not a student.
const ACCEPT_ATTR =
  '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,image/*';

export default function ResourceManager() {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  // Debounced so typing a query fires one request, not one per keystroke.
  const debouncedQ = useDebouncedValue(q, 300);
  const [page, setPage] = useState(1);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Resource | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Resource | null>(null);
  const [deleting, setDeleting] = useState(false);

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
    setDeleting(true);
    try {
      // Via the admin route: deletes the stored file and the RAG entry too,
      // not just the database row.
      await adminFetch(`/api/admin/resources/${id}`, { method: 'DELETE' });
      setDeleteTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">School Resources</h1>
          <p className="text-sm text-gray-500 mt-1">Upload, edit, and manage public learning materials.</p>
        </div>
        <button
          onClick={() => setUploadOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-500 rounded-xl shadow hover:shadow-md transition-all"
        >
          <Plus className="w-4 h-4" /> Upload resources
        </button>
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
                  <button onClick={() => setEditTarget(r)} title="Edit" className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/20">
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button onClick={() => setDeleteTarget(r)} title="Delete" className="p-1.5 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))
          )}

          {data.totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-700 disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-xs text-gray-500">Page {page} of {data.totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                disabled={page >= data.totalPages}
                className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-700 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {uploadOpen && (
        <UploadDialog
          onClose={() => setUploadOpen(false)}
          onDone={() => { setUploadOpen(false); void load(); }}
        />
      )}

      {editTarget && (
        <EditDialog
          resource={editTarget}
          onClose={() => setEditTarget(null)}
          onDone={() => { setEditTarget(null); void load(); }}
        />
      )}

      {deleteTarget && (
        <DeleteDialog
          resource={deleteTarget}
          busy={deleting}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void remove(deleteTarget.id)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload dialog — ported from the Resource Library's UploadResourceDialog so
// the admin console can do everything the staff form does: single files and
// whole folders. The file bytes go to /api/upload (multipart, raw fetch — it
// must not carry a JSON Content-Type), then the metadata row is created.
// ---------------------------------------------------------------------------

type FolderFileItem = {
  file: File;
  relativePath: string;
  status: 'pending' | 'uploading' | 'publishing' | 'done' | 'error';
  error?: string;
};

function UploadDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'single' | 'folder'>('single');
  const [error, setError] = useState<string | null>(null);

  // single-file state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState('');
  const [fileMeta, setFileMeta] = useState<{ url: string; name: string; size: number; type: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // folder state
  const [folderItems, setFolderItems] = useState<FolderFileItem[]>([]);
  const [folderSubject, setFolderSubject] = useState('');
  const [folderCategory, setFolderCategory] = useState('');
  const [folderBusy, setFolderBusy] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const folderDoneCount = folderItems.filter((it) => it.status === 'done').length;
  const folderErrorCount = folderItems.filter((it) => it.status === 'error').length;

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > RESOURCE_UPLOAD_MAX_BYTES) {
      setError('File too large (max 25 MB).');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.fileUrl) throw new Error(data.error || 'Upload failed');
      setFileMeta({ url: data.fileUrl, name: data.fileName, size: data.fileSize, type: data.mimeType });
      if (!title) setTitle(data.fileName.replace(/\.[^.]+$/, ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async () => {
    if (!title.trim() || !fileMeta) {
      setError('Title and file are required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await adminFetch('/api/school-resources', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          subject: subject.trim() || undefined,
          category: category.trim() || undefined,
          fileUrl: fileMeta.url,
          fileName: fileMeta.name,
          fileSize: fileMeta.size,
          mimeType: fileMeta.type,
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to publish');
      setSubmitting(false);
    }
  };

  const handleFolderPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    setError(null);
    const accepted: FolderFileItem[] = [];
    let skipped = 0;
    let tooBig = 0;
    for (const f of files) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
      const segments = rel.split('/');
      if (segments.some(isHiddenUploadSegment)) { skipped++; continue; }
      if (!ALLOWED_RESOURCE_EXTS.has(ext)) { skipped++; continue; }
      if (f.size > RESOURCE_UPLOAD_MAX_BYTES) { tooBig++; continue; }
      accepted.push({ file: f, relativePath: rel, status: 'pending' });
    }
    if (accepted.length === 0) {
      setError(
        'No uploadable files in that folder.' +
        (skipped ? ` ${skipped} hidden/unsupported file${skipped === 1 ? '' : 's'} skipped.` : '') +
        (tooBig ? ` ${tooBig} file${tooBig === 1 ? '' : 's'} over 25 MB.` : '')
      );
      return;
    }
    setFolderItems(accepted);
  };

  const updateItem = (idx: number, patch: Partial<FolderFileItem>) =>
    setFolderItems((cur) => cur.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  // Upload + publish one file. Returns true on success.
  const processOne = async (item: FolderFileItem, idx: number, subj?: string, cat?: string): Promise<boolean> => {
    try {
      updateItem(idx, { status: 'uploading', error: undefined });
      const fd = new FormData();
      fd.append('file', item.file);
      const upRes = await fetch('/api/upload', { method: 'POST', body: fd });
      const upData = await upRes.json();
      if (!upRes.ok || !upData.fileUrl) throw new Error(upData.error || 'Upload failed');

      updateItem(idx, { status: 'publishing' });
      // Keep the folder's relative path (minus the file name) so the server
      // can resolve/create the matching SchoolResourceFolder chain — same
      // convention the staff folder upload uses.
      const parts = item.relativePath.split('/').filter(Boolean);
      const folderPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
      await adminFetch('/api/school-resources', {
        method: 'POST',
        body: JSON.stringify({
          title: item.file.name.replace(/\.[^.]+$/, ''),
          folderPath: folderPath || undefined,
          subject: subj,
          category: cat,
          fileUrl: upData.fileUrl,
          fileName: upData.fileName,
          fileSize: upData.fileSize,
          mimeType: upData.mimeType,
        }),
      });
      updateItem(idx, { status: 'done' });
      return true;
    } catch (err) {
      updateItem(idx, { status: 'error', error: err instanceof Error ? err.message : 'Failed' });
      return false;
    }
  };

  const handleFolderSubmit = async () => {
    if (folderItems.length === 0) return;
    setFolderBusy(true);
    setError(null);
    const subj = folderSubject.trim() || undefined;
    const cat = folderCategory.trim() || undefined;
    // Run uploads with a small concurrency cap to be gentle on the server.
    const CONCURRENCY = 3;
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const runNext = async (): Promise<void> => {
      while (cursor < folderItems.length) {
        const idx = cursor++;
        await processOne(folderItems[idx], idx, subj, cat);
      }
    };
    for (let i = 0; i < Math.min(CONCURRENCY, folderItems.length); i++) workers.push(runNext());
    await Promise.all(workers);
    setFolderBusy(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      // Cancel and the X are already disabled while an upload runs; the
      // backdrop was not, so a stray click unmounted the dialog mid-folder,
      // throwing away every file's progress while the requests kept going.
      onClick={folderBusy ? undefined : onClose}
    >
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <Upload className="w-5 h-5 text-indigo-500" /> Upload School Resources
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {mode === 'single' ? 'Publish a file to the whole school.' : 'Upload a whole folder — each file becomes its own resource.'}
            </p>
          </div>
          <button onClick={onClose} disabled={submitting || folderBusy} className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-40">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 pt-4">
          <div className="inline-flex p-1 bg-gray-100 dark:bg-gray-900 rounded-xl text-sm">
            <button
              type="button"
              onClick={() => { setMode('single'); setError(null); }}
              className={`px-3 py-1.5 rounded-lg font-medium transition-colors inline-flex items-center gap-1.5 ${
                mode === 'single'
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              <Upload className="w-3.5 h-3.5" /> Single File
            </button>
            <button
              type="button"
              onClick={() => { setMode('folder'); setError(null); }}
              className={`px-3 py-1.5 rounded-lg font-medium transition-colors inline-flex items-center gap-1.5 ${
                mode === 'folder'
                  ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              <FolderUp className="w-3.5 h-3.5" /> Folder
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {mode === 'single' ? (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">File</label>
                {!fileMeta ? (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="w-full px-4 py-6 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-500 hover:border-indigo-400 hover:bg-indigo-50/40 dark:hover:bg-indigo-900/10 transition-colors disabled:opacity-50"
                  >
                    {uploading ? (
                      <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Uploading…</span>
                    ) : (
                      <span className="inline-flex items-center gap-2"><Upload className="w-4 h-4" /> Click to choose a file (PDF, Word, Excel, PowerPoint, images — up to 25 MB)</span>
                    )}
                  </button>
                ) : (
                  <div className="flex items-center gap-3 px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl">
                    <Paperclip className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    <span className="flex-1 truncate text-sm text-gray-700 dark:text-gray-300">{fileMeta.name}</span>
                    <span className="text-xs text-gray-400">{(fileMeta.size / 1024).toFixed(0)} KB</span>
                    <button
                      type="button"
                      onClick={() => setFileMeta(null)}
                      className="p-1 text-gray-400 hover:text-red-600 rounded transition-colors"
                      title="Remove file"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
                <input ref={fileInputRef} type="file" accept={ACCEPT_ATTR} onChange={handleFilePick} className="hidden" />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Y10 Physics S1 Revision Worksheet"
                  className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Subject (optional)</label>
                  <input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="e.g. Physics"
                    className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Category (optional)</label>
                  <input
                    type="text"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="e.g. Worksheet, Slides, Exam, or Handout"
                    className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Description (optional)</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Revision sheet covering Newton's laws and graph interpretation."
                  rows={3}
                  className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none resize-y"
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Folder</label>
                {folderItems.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => folderInputRef.current?.click()}
                    className="w-full px-4 py-8 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-500 hover:border-indigo-400 hover:bg-indigo-50/40 dark:hover:bg-indigo-900/10 transition-colors"
                  >
                    <FolderUp className="w-6 h-6 mx-auto mb-2 text-gray-400" />
                    <span className="inline-flex items-center gap-2">Click to choose a folder — every supported file inside will be uploaded as a separate resource.</span>
                    <p className="text-xs text-gray-400 mt-2">
                      Supports PDF, Word, Excel, PowerPoint, TXT, Markdown, images. Hidden/system files and files over 25 MB are skipped.
                    </p>
                  </button>
                ) : (
                  <div className="px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {folderItems.length} file{folderItems.length === 1 ? '' : 's'} ready
                      </span>
                      <button
                        type="button"
                        onClick={() => { setFolderItems([]); setError(null); }}
                        disabled={folderBusy}
                        className="p-1 text-gray-400 hover:text-red-600 rounded transition-colors disabled:opacity-50"
                        title="Clear selection"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <ul className="max-h-48 overflow-y-auto space-y-1 pr-1">
                      {folderItems.map((it, idx) => (
                        <li key={idx} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700">
                          <FileIcon className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                          <span className="flex-1 truncate text-gray-700 dark:text-gray-300" title={it.relativePath}>{it.relativePath}</span>
                          <span className="text-gray-400 flex-shrink-0">{(it.file.size / 1024).toFixed(0)} KB</span>
                          {it.status === 'uploading' && <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin flex-shrink-0" />}
                          {it.status === 'publishing' && <Loader2 className="w-3.5 h-3.5 text-amber-500 animate-spin flex-shrink-0" />}
                          {it.status === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />}
                          {it.status === 'error' && (
                            <span title={it.error} className="flex-shrink-0">
                              <XCircle className="w-3.5 h-3.5 text-red-500" />
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <input
                  ref={folderInputRef}
                  type="file"
                  // @ts-expect-error webkitdirectory is a non-standard but widely-supported attribute
                  webkitdirectory=""
                  directory=""
                  multiple
                  onChange={handleFolderPick}
                  className="hidden"
                />
              </div>

              {folderItems.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Apply Subject to all (optional)</label>
                    <input
                      type="text"
                      value={folderSubject}
                      onChange={(e) => setFolderSubject(e.target.value)}
                      placeholder="e.g. Physics"
                      disabled={folderBusy}
                      className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-60"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Apply Category to all (optional)</label>
                    <input
                      type="text"
                      value={folderCategory}
                      onChange={(e) => setFolderCategory(e.target.value)}
                      placeholder="e.g. Worksheet, Slides, Exam, or Handout"
                      disabled={folderBusy}
                      className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-60"
                    />
                  </div>
                </div>
              )}

              {folderBusy && (
                <div className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Uploading {folderDoneCount}/{folderItems.length}…
                </div>
              )}
              {!folderBusy && folderDoneCount > 0 && (
                <div className="text-xs text-green-600 dark:text-green-400">
                  {folderDoneCount} uploaded successfully{folderErrorCount ? `, ${folderErrorCount} failed` : ''}.
                </div>
              )}
            </>
          )}
          {error && <ErrorBox message={error} />}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={submitting || folderBusy}
            className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-xl transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          {mode === 'single' ? (
            <button
              onClick={() => void handleSubmit()}
              disabled={submitting || !title.trim() || !fileMeta}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-500 rounded-xl shadow hover:shadow-md transition-all disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {submitting ? 'Publishing…' : 'Publish Resource'}
            </button>
          ) : folderDoneCount > 0 && !folderBusy ? (
            <button
              onClick={onDone}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-500 rounded-xl shadow hover:shadow-md transition-all"
            >
              <CheckCircle2 className="w-4 h-4" /> Done
            </button>
          ) : (
            <button
              onClick={() => void handleFolderSubmit()}
              disabled={folderBusy || folderItems.length === 0}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-500 rounded-xl shadow hover:shadow-md transition-all disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {folderBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FolderUp className="w-4 h-4" />}
              {folderBusy ? `Uploading ${folderDoneCount}/${folderItems.length}…` : `Upload ${folderItems.length || ''} Resource${folderItems.length === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit dialog — metadata always editable; the file itself can be swapped for
// a fresh upload. Swapping deletes the old stored object server-side.
// ---------------------------------------------------------------------------

function EditDialog({ resource, onClose, onDone }: { resource: Resource; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState(resource.title);
  const [description, setDescription] = useState(resource.description ?? '');
  const [subject, setSubject] = useState(resource.subject ?? '');
  const [category, setCategory] = useState(resource.category ?? '');
  const [fileName, setFileName] = useState(resource.fileName);

  const [replacement, setReplacement] = useState<{ url: string; name: string; size: number; type: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > RESOURCE_UPLOAD_MAX_BYTES) {
      setError('File too large (max 25 MB).');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.fileUrl) throw new Error(data.error || 'Upload failed');
      setReplacement({ url: data.fileUrl, name: data.fileName, size: data.fileSize, type: data.mimeType });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async () => {
    if (!title.trim() || !fileName.trim()) {
      setError('Title and file name are required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await adminFetch(`/api/admin/resources/${resource.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: title.trim(),
          description,
          subject,
          category,
          fileName: fileName.trim(),
          ...(replacement ? {
            replacementFile: {
              fileUrl: replacement.url,
              fileName: replacement.name,
              fileSize: replacement.size,
              mimeType: replacement.type,
            },
          } : {}),
        }),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Pencil className="w-5 h-5 text-indigo-500" /> Edit Resource
          </h2>
          <button onClick={onClose} disabled={saving} className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-40">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Subject</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g. Physics"
                className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Category</label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. Worksheet, Slides, Exam, or Handout"
                className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">File name (shown to students)</label>
            <input
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none resize-y"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Replace file</label>
            {replacement ? (
              <div className="flex items-center gap-3 px-3 py-2.5 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-xl">
                <Paperclip className="w-4 h-4 text-indigo-400 flex-shrink-0" />
                <span className="flex-1 truncate text-sm text-gray-700 dark:text-gray-300">{replacement.name}</span>
                <span className="text-xs text-gray-400">{(replacement.size / 1024).toFixed(0)} KB</span>
                <button
                  type="button"
                  onClick={() => setReplacement(null)}
                  disabled={saving}
                  className="p-1 text-gray-400 hover:text-red-600 rounded transition-colors disabled:opacity-40"
                  title="Undo replacement"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="w-full px-4 py-4 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-500 hover:border-indigo-400 hover:bg-indigo-50/40 dark:hover:bg-indigo-900/10 transition-colors disabled:opacity-50"
              >
                {uploading ? (
                  <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Uploading…</span>
                ) : (
                  'Choose a new file to replace the current one (the old file is deleted on save)'
                )}
              </button>
            )}
            <p className="text-[11px] text-gray-400 mt-1">
              Current: {resource.fileName} · {(resource.fileSize / 1024 / 1024).toFixed(1)} MB
            </p>
            <input ref={fileInputRef} type="file" accept={ACCEPT_ATTR} onChange={handleFilePick} className="hidden" />
          </div>

          {error && <ErrorBox message={error} />}
        </div>

        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-xl transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-500 rounded-xl shadow hover:shadow-md transition-all disabled:opacity-60"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete dialog — the native confirm() is gone: this is the most destructive
// action on the page and deserves a real dialog that says what is lost.
// ---------------------------------------------------------------------------

function DeleteDialog({ resource, busy, onCancel, onConfirm }: { resource: Resource; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onCancel}>
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-red-100 dark:bg-red-900/30 grid place-items-center flex-shrink-0">
            <TriangleAlert className="w-5 h-5 text-red-600" />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">Delete resource?</h3>
            <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
              <span className="font-medium">{resource.title}</span> will be permanently removed,
              along with the stored file ({(resource.fileSize / 1024 / 1024).toFixed(1)} MB). Students
              lose access immediately, and search stops returning it. This cannot be undone.
            </p>
          </div>
        </div>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-xl transition-colors disabled:opacity-50"
          >
            Keep it
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-xl shadow transition-colors disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
