'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Trash2, Search, Download, FileText, Upload, X, Loader2, Paperclip, FolderUp,
  CheckCircle2, XCircle, Plus, Pencil, File as FileIcon, TriangleAlert,
} from 'lucide-react';
import { adminFetch } from '../lib/fetch';
import { LoadingSpinner, ErrorBox } from './AdminDashboard';
import { useDebouncedValue } from '../../components/useDebouncedValue';
import ResourceFolderPicker from '../../components/ResourceFolderPicker';
import { readUploadResult } from '@/lib/upload-client';
import {
  ALLOWED_RESOURCE_EXTS,
  RESOURCE_UPLOAD_MAX_BYTES,
  RESOURCE_UPLOAD_MAX_LABEL,
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
  folderId: string | null;
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
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<Array<{ id: string; name: string }>>([]);
  const [folderRefreshTick, setFolderRefreshTick] = useState(0);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Resource | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Resource | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ type: 'resources', page: String(page) });
      params.set('folderId', currentFolderId ?? '');
      if (debouncedQ) params.set('q', debouncedQ);
      const res = await adminFetch<Response>(`/api/admin/content?${params}`);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [currentFolderId, debouncedQ, page]);

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
          <p className="text-sm text-muted mt-1">Upload, edit, and manage public learning materials.</p>
        </div>
        <button
          onClick={() => setUploadOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all"
        >
          <Plus className="w-4 h-4" /> Upload resources
        </button>
      </header>

      {error && <ErrorBox message={error} />}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
        <input type="text" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="e.g. worksheet, 2024, or Ms Lee" className="w-full pl-9 pr-3 py-2 bg-surface border border-strong rounded-md text-sm focus:ring-2 focus:ring-ring/25 outline-none" />
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold">Folders</h2>
        <ResourceFolderPicker key={folderRefreshTick} value={currentFolderId} initialBreadcrumb={breadcrumb} onChange={(id, crumbs) => { setCurrentFolderId(id); setBreadcrumb(crumbs); setPage(1); }} />
      </div>

      {/* Only show the spinner before the first result set arrives. Swapping
          the table out on every refetch made the list flash and jump while the
          search box was still being typed into. */}
      {loading && !data ? <LoadingSpinner /> : data && (
        <div className="space-y-3">
          {data.items.length === 0 ? (
            <p className="text-sm text-muted italic py-8 text-center">No resources found.</p>
          ) : (
            data.items.map((r) => (
              <div key={r.id} className="bg-surface rounded-lg border border-line p-4 flex items-start gap-3">
                <div className="w-10 h-10 bg-surface-raised rounded-md flex items-center justify-center flex-shrink-0">
                  <FileText className="w-5 h-5 text-muted" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium text-sm truncate">{r.title}</h3>
                  {r.description && <p className="text-xs text-muted mt-0.5 line-clamp-2">{r.description}</p>}
                  <p className="text-xs text-muted mt-1">
                    {r.category && <span className="mr-2">{r.category}</span>}
                    {r.subject && <span className="mr-2">· {r.subject}</span>}
                    · {(r.fileSize / 1024 / 1024).toFixed(1)} MB
                    · {r.downloads} downloads
                  </p>
                  <p className="text-[10px] text-muted mt-0.5">
                    by {r.uploader?.name ?? r.uploader?.email} · {new Date(r.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <a href={r.fileUrl} download className="p-1.5 rounded-md text-muted hover:bg-surface-hover" title="Download" aria-label="Download">
                    <Download className="w-4 h-4" />
                  </a>
                  <button onClick={() => setEditTarget(r)} title="Edit" aria-label="Edit" className="p-1.5 rounded-md text-muted hover:text-primary hover:bg-surface-hover">
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button onClick={() => setDeleteTarget(r)} title="Delete" aria-label="Delete" className="p-1.5 rounded-md text-danger hover:bg-danger-subtle">
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
                className="px-3 py-1.5 text-sm rounded-md border border-strong disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-xs text-muted">Page {page} of {data.totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                disabled={page >= data.totalPages}
                className="px-3 py-1.5 text-sm rounded-md border border-strong disabled:opacity-40"
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}

      {uploadOpen && (
        <UploadDialog
          initialFolderId={currentFolderId}
          initialBreadcrumb={breadcrumb}
          onClose={() => setUploadOpen(false)}
          onDone={() => { setUploadOpen(false); setFolderRefreshTick((tick) => tick + 1); void load(); }}
        />
      )}

      {editTarget && (
        <EditDialog
          resource={editTarget}
          initialBreadcrumb={breadcrumb}
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

function UploadDialog({ onClose, onDone, initialFolderId, initialBreadcrumb }: {
  onClose: () => void;
  onDone: () => void;
  initialFolderId: string | null;
  initialBreadcrumb: Array<{ id: string; name: string }>;
}) {
  const [mode, setMode] = useState<'single' | 'folder'>('single');
  const [error, setError] = useState<string | null>(null);

  // single-file state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState('');
  const [destinationId, setDestinationId] = useState<string | null>(initialFolderId);
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
      setError(`File too large (max ${RESOURCE_UPLOAD_MAX_LABEL}).`);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (destinationId) fd.append('resourceFolderId', destinationId);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await readUploadResult(res);
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
          folderId: destinationId,
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
        (tooBig ? ` ${tooBig} file${tooBig === 1 ? '' : 's'} over ${RESOURCE_UPLOAD_MAX_LABEL}.` : '')
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
      const parts = item.relativePath.split('/').filter(Boolean);
      const folderPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
      if (folderPath) fd.append('resourceFolderPath', folderPath);
      if (destinationId) fd.append('resourceParentFolderId', destinationId);
      if (!folderPath && destinationId) fd.append('resourceFolderId', destinationId);
      const upRes = await fetch('/api/upload', { method: 'POST', body: fd });
      const upData = await readUploadResult(upRes);

      updateItem(idx, { status: 'publishing' });
      // Keep the folder's relative path (minus the file name) so the server
      // can resolve/create the matching SchoolResourceFolder chain — same
      // convention the staff folder upload uses.
      await adminFetch('/api/school-resources', {
        method: 'POST',
        body: JSON.stringify({
          title: item.file.name.replace(/\.[^.]+$/, ''),
          folderId: upData.resourceFolderId,
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
        className="bg-surface rounded-lg shadow-overlay w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-line flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-primary flex items-center gap-2">
              <Upload className="w-5 h-5 text-secondary" /> Upload School Resources
            </h2>
            <p className="text-xs text-muted mt-0.5">
              {mode === 'single' ? 'Publish a file to the whole school.' : 'Upload a whole folder — each file becomes its own resource.'}
            </p>
          </div>
          <button onClick={onClose} disabled={submitting || folderBusy} className="p-2 text-muted hover:text-secondary hover:bg-surface-hover rounded-md transition-colors disabled:opacity-40">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 pt-4">
          <div className="inline-flex p-1 bg-surface-raised rounded-lg text-sm">
            <button
              type="button"
              onClick={() => { setMode('single'); setError(null); }}
              className={`px-3 py-1.5 rounded-md font-medium transition-colors inline-flex items-center gap-1.5 ${
                mode === 'single'
                  ? 'bg-surface text-primary'
                  : 'text-muted hover:text-secondary'
              }`}
            >
              <Upload className="w-3.5 h-3.5" /> Single File
            </button>
            <button
              type="button"
              onClick={() => { setMode('folder'); setError(null); }}
              className={`px-3 py-1.5 rounded-md font-medium transition-colors inline-flex items-center gap-1.5 ${
                mode === 'folder'
                  ? 'bg-surface text-primary'
                  : 'text-muted hover:text-secondary'
              }`}
            >
              <FolderUp className="w-3.5 h-3.5" /> Folder
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-secondary mb-1.5">Upload into folder</label>
            <ResourceFolderPicker value={destinationId} onChange={setDestinationId} initialBreadcrumb={initialBreadcrumb} disabled={uploading || submitting || folderBusy || Boolean(fileMeta) || folderDoneCount > 0} />
          </div>
          {mode === 'single' ? (
            <>
              <div>
                <label className="block text-sm font-medium text-secondary mb-1.5">File</label>
                {!fileMeta ? (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="w-full px-4 py-6 border-2 border-dashed border-strong rounded-lg text-sm text-muted hover:border-strong hover:bg-surface-hover transition-colors disabled:opacity-50"
                  >
                    {uploading ? (
                      <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Uploading…</span>
                    ) : (
                      <span className="inline-flex items-center gap-2"><Upload className="w-4 h-4" /> Click to choose a file (PDF, Word, Excel, PowerPoint, images — up to {RESOURCE_UPLOAD_MAX_LABEL})</span>
                    )}
                  </button>
                ) : (
                  <div className="flex items-center gap-3 px-3 py-2.5 bg-surface-raised border border-line rounded-lg">
                    <Paperclip className="w-4 h-4 text-muted flex-shrink-0" />
                    <span className="flex-1 truncate text-sm text-secondary">{fileMeta.name}</span>
                    <span className="text-xs text-muted">{(fileMeta.size / 1024).toFixed(0)} KB</span>
                    <button
                      type="button"
                      onClick={() => setFileMeta(null)}
                      className="p-1 text-muted hover:text-danger rounded-sm transition-colors"
                      title="Remove file" aria-label="Remove file"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
                <input ref={fileInputRef} type="file" accept={ACCEPT_ATTR} onChange={handleFilePick} className="hidden" />
              </div>

              <div>
                <label className="block text-sm font-medium text-secondary mb-1.5">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Y10 Physics S1 Revision Worksheet"
                  className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm focus:ring-2 focus:ring-ring/25 outline-none"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-secondary mb-1.5">Subject (optional)</label>
                  <input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="e.g. Physics"
                    className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm focus:ring-2 focus:ring-ring/25 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-secondary mb-1.5">Category (optional)</label>
                  <input
                    type="text"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="e.g. Worksheet, Slides, Exam, or Handout"
                    className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm focus:ring-2 focus:ring-ring/25 outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-secondary mb-1.5">Description (optional)</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Revision sheet covering Newton's laws and graph interpretation."
                  rows={3}
                  className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm focus:ring-2 focus:ring-ring/25 outline-none resize-y"
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-secondary mb-1.5">Folder</label>
                {folderItems.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => folderInputRef.current?.click()}
                    className="w-full px-4 py-8 border-2 border-dashed border-strong rounded-lg text-sm text-muted hover:border-strong hover:bg-surface-hover transition-colors"
                  >
                    <FolderUp className="w-6 h-6 mx-auto mb-2 text-muted" />
                    <span className="inline-flex items-center gap-2">Click to choose a folder — every supported file inside will be uploaded as a separate resource.</span>
                    <p className="text-xs text-muted mt-2">
                      Supports PDF, Word, Excel, PowerPoint, TXT, Markdown, images. Hidden/system files and files over {RESOURCE_UPLOAD_MAX_LABEL} are skipped.
                    </p>
                  </button>
                ) : (
                  <div className="px-3 py-2.5 bg-surface-raised border border-line rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-secondary">
                        {folderItems.length} file{folderItems.length === 1 ? '' : 's'} ready
                      </span>
                      <button
                        type="button"
                        onClick={() => { setFolderItems([]); setError(null); }}
                        disabled={folderBusy}
                        className="p-1 text-muted hover:text-danger rounded-sm transition-colors disabled:opacity-50"
                        title="Clear selection" aria-label="Clear selection"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <ul className="max-h-48 overflow-y-auto space-y-1 pr-1">
                      {folderItems.map((it, idx) => (
                        <li key={idx} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-sm bg-surface border border-subtle">
                          <FileIcon className="w-3.5 h-3.5 text-muted flex-shrink-0" />
                          <span className="flex-1 truncate text-secondary" title={it.relativePath}>{it.relativePath}</span>
                          <span className="text-muted flex-shrink-0">{(it.file.size / 1024).toFixed(0)} KB</span>
                          {it.status === 'uploading' && <Loader2 className="w-3.5 h-3.5 text-secondary animate-spin flex-shrink-0" />}
                          {it.status === 'publishing' && <Loader2 className="w-3.5 h-3.5 text-warning animate-spin flex-shrink-0" />}
                          {it.status === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-accent-text flex-shrink-0" />}
                          {it.status === 'error' && (
                            <span title={it.error} className="flex-shrink-0">
                              <XCircle className="w-3.5 h-3.5 text-danger" />
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
                    <label className="block text-sm font-medium text-secondary mb-1.5">Apply Subject to all (optional)</label>
                    <input
                      type="text"
                      value={folderSubject}
                      onChange={(e) => setFolderSubject(e.target.value)}
                      placeholder="e.g. Physics"
                      disabled={folderBusy}
                      className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm focus:ring-2 focus:ring-ring/25 outline-none disabled:opacity-60"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-secondary mb-1.5">Apply Category to all (optional)</label>
                    <input
                      type="text"
                      value={folderCategory}
                      onChange={(e) => setFolderCategory(e.target.value)}
                      placeholder="e.g. Worksheet, Slides, Exam, or Handout"
                      disabled={folderBusy}
                      className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm focus:ring-2 focus:ring-ring/25 outline-none disabled:opacity-60"
                    />
                  </div>
                </div>
              )}

              {folderBusy && (
                <div className="text-xs text-secondary flex items-center gap-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Uploading {folderDoneCount}/{folderItems.length}…
                </div>
              )}
              {!folderBusy && folderDoneCount > 0 && (
                <div className="text-xs text-accent-text">
                  {folderDoneCount} uploaded successfully{folderErrorCount ? `, ${folderErrorCount} failed` : ''}.
                </div>
              )}
            </>
          )}
          {error && <ErrorBox message={error} />}
        </div>

        <div className="px-6 py-4 border-t border-line flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={submitting || folderBusy}
            className="px-4 py-2.5 text-sm font-medium text-secondary bg-surface-raised hover:bg-surface-active rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          {mode === 'single' ? (
            <button
              onClick={() => void handleSubmit()}
              disabled={submitting || !title.trim() || !fileMeta}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {submitting ? 'Publishing…' : 'Publish Resource'}
            </button>
          ) : folderDoneCount > 0 && !folderBusy ? (
            <button
              onClick={onDone}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all"
            >
              <CheckCircle2 className="w-4 h-4" /> Done
            </button>
          ) : (
            <button
              onClick={() => void handleFolderSubmit()}
              disabled={folderBusy || folderItems.length === 0}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all disabled:opacity-60 disabled:cursor-not-allowed"
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

function EditDialog({ resource, onClose, onDone, initialBreadcrumb }: {
  resource: Resource;
  onClose: () => void;
  onDone: () => void;
  initialBreadcrumb: Array<{ id: string; name: string }>;
}) {
  const [title, setTitle] = useState(resource.title);
  const [description, setDescription] = useState(resource.description ?? '');
  const [subject, setSubject] = useState(resource.subject ?? '');
  const [category, setCategory] = useState(resource.category ?? '');
  const [folderId, setFolderId] = useState<string | null>(resource.folderId);
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
      setError(`File too large (max ${RESOURCE_UPLOAD_MAX_LABEL}).`);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (folderId) fd.append('resourceFolderId', folderId);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await readUploadResult(res);
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
          folderId,
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
        className="bg-surface rounded-lg shadow-overlay w-full max-w-xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-line flex items-center justify-between">
          <h2 className="text-lg font-bold text-primary flex items-center gap-2">
            <Pencil className="w-5 h-5 text-secondary" /> Edit Resource
          </h2>
          <button onClick={onClose} disabled={saving} className="p-2 text-muted hover:text-secondary hover:bg-surface-hover rounded-md transition-colors disabled:opacity-40">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-secondary mb-1.5">Folder</label>
            <ResourceFolderPicker value={folderId} onChange={setFolderId} initialBreadcrumb={initialBreadcrumb} disabled={uploading || saving || Boolean(replacement)} />
          </div>
          <div>
            <label className="block text-sm font-medium text-secondary mb-1.5">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm focus:ring-2 focus:ring-ring/25 outline-none"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-secondary mb-1.5">Subject</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g. Physics"
                className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm focus:ring-2 focus:ring-ring/25 outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-secondary mb-1.5">Category</label>
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="e.g. Worksheet, Slides, Exam, or Handout"
                className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm focus:ring-2 focus:ring-ring/25 outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-secondary mb-1.5">File name (shown to students)</label>
            <input
              type="text"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm focus:ring-2 focus:ring-ring/25 outline-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-secondary mb-1.5">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm focus:ring-2 focus:ring-ring/25 outline-none resize-y"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-secondary mb-1.5">Replace file</label>
            {replacement ? (
              <div className="flex items-center gap-3 px-3 py-2.5 bg-surface-raised border border-line rounded-lg">
                <Paperclip className="w-4 h-4 text-secondary flex-shrink-0" />
                <span className="flex-1 truncate text-sm text-secondary">{replacement.name}</span>
                <span className="text-xs text-muted">{(replacement.size / 1024).toFixed(0)} KB</span>
                <button
                  type="button"
                  onClick={() => setReplacement(null)}
                  disabled={saving}
                  className="p-1 text-muted hover:text-danger rounded-sm transition-colors disabled:opacity-40"
                  title="Undo replacement" aria-label="Undo replacement"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="w-full px-4 py-4 border-2 border-dashed border-strong rounded-lg text-sm text-muted hover:border-strong hover:bg-surface-hover transition-colors disabled:opacity-50"
              >
                {uploading ? (
                  <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Uploading…</span>
                ) : (
                  'Choose a new file to replace the current one (the old file is deleted on save)'
                )}
              </button>
            )}
            <p className="text-[11px] text-muted mt-1">
              Current: {resource.fileName} · {(resource.fileSize / 1024 / 1024).toFixed(1)} MB
            </p>
            <input ref={fileInputRef} type="file" accept={ACCEPT_ATTR} onChange={handleFilePick} className="hidden" />
          </div>

          {error && <ErrorBox message={error} />}
        </div>

        <div className="px-6 py-4 border-t border-line flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2.5 text-sm font-medium text-secondary bg-surface-raised hover:bg-surface-active rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all disabled:opacity-60"
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
        className="bg-surface rounded-lg shadow-overlay w-full max-w-md p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-danger-subtle grid place-items-center flex-shrink-0">
            <TriangleAlert className="w-5 h-5 text-danger" />
          </div>
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-primary">Delete resource?</h3>
            <p className="text-sm text-secondary mt-1">
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
            className="px-4 py-2.5 text-sm font-medium text-secondary bg-surface-raised hover:bg-surface-active rounded-lg transition-colors disabled:opacity-50"
          >
            Keep it
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-danger hover:bg-danger rounded-lg shadow transition-colors disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}
