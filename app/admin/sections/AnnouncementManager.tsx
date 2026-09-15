'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Plus, Trash2, Pencil, Pin, X, Loader2, Megaphone, Eye, EyeOff } from 'lucide-react';
import { useConfirm } from '../../components/useConfirm';
import { adminFetch } from '../lib/fetch';
import { LoadingSpinner, ErrorBox } from './AdminDashboard';

const RichTextEditor = dynamic(() => import('../../components/RichTextEditor'), { ssr: false });

type Announcement = {
  id: string;
  title: string;
  body: string;
  severity: string;
  audience: string;
  pinned: boolean;
  published: boolean;
  publishedAt: string;
  expiresAt: string | null;
  createdAt: string;
  author: { name: string | null; email: string; image?: string | null };
};

const SEVERITY_STYLES: Record<string, string> = {
  info: 'bg-surface-raised text-secondary',
  success: 'bg-accent-subtle text-accent-text',
  warning: 'bg-warning-subtle text-warning',
  critical: 'bg-danger-subtle text-danger',
};

export default function AnnouncementManager() {
  const { confirm, confirmDialog } = useConfirm();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminFetch<{ announcements: Announcement[] }>('/api/admin/announcements');
      setItems(res.announcements);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  const remove = async (id: string) => {
    const ok = await confirm({
      title: 'Delete this announcement?',
      message:
        'It disappears from the banner, the notification feed and the announcements page for everyone. This cannot be undone.',
      confirmLabel: 'Delete announcement',
    });
    if (!ok) return;
    try {
      await adminFetch(`/api/admin/announcements/${id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const togglePublished = async (a: Announcement) => {
    try {
      await adminFetch(`/api/admin/announcements/${a.id}`, { method: 'PATCH', body: JSON.stringify({ published: !a.published }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  };

  const togglePinned = async (a: Announcement) => {
    try {
      await adminFetch(`/api/admin/announcements/${a.id}`, { method: 'PATCH', body: JSON.stringify({ pinned: !a.pinned }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {confirmDialog}
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Announcements</h1>
          <p className="text-sm text-muted mt-1">Publish platform-wide announcements. Notifications are sent to all matched users.</p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover"
        >
          <Plus className="w-4 h-4" /> New
        </button>
      </header>

      {error && <ErrorBox message={error} />}
      {loading ? <LoadingSpinner /> : (
        <div className="space-y-3">
          {items.length === 0 ? (
            <p className="text-sm text-muted italic py-8 text-center">No announcements yet.</p>
          ) : (
            items.map((a) => (
              <div key={a.id} className="bg-surface rounded-lg border border-line p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-sm font-medium uppercase ${SEVERITY_STYLES[a.severity] ?? SEVERITY_STYLES.info}`}>{a.severity}</span>
                      <span className="text-[10px] px-1.5 py-0.5 bg-surface-raised text-secondary rounded-sm">{a.audience}</span>
                      {a.pinned && <Pin className="w-3.5 h-3.5 text-secondary" />}
                      {!a.published && <span className="text-[10px] px-1.5 py-0.5 bg-surface-active text-secondary rounded-sm">DRAFT</span>}
                    </div>
                    <h3 className="font-medium text-sm">{a.title}</h3>
                    <p className="text-xs text-muted mt-1 line-clamp-2">{a.body.replace(/<[^>]+>/g, '')}</p>
                    <p className="text-[10px] text-muted mt-1">
                      by {a.author?.name ?? a.author?.email ?? 'Admin'} · {new Date(a.publishedAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={() => togglePublished(a)} title={a.published ? 'Unpublish' : 'Publish'} aria-label={a.published ? 'Unpublish' : 'Publish'} className="p-1.5 rounded-md text-muted hover:bg-surface-hover">
                      {a.published ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                    </button>
                    <button onClick={() => togglePinned(a)} title={a.pinned ? 'Unpin' : 'Pin'} aria-label={a.pinned ? 'Unpin' : 'Pin'} className={`p-1.5 rounded-md hover:bg-surface-hover ${a.pinned ? 'text-secondary' : 'text-muted'}`}>
                      <Pin className="w-4 h-4" />
                    </button>
                    <button onClick={() => setEditing(a)} title="Edit" aria-label="Edit" className="p-1.5 rounded-md text-muted hover:bg-surface-hover">
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button onClick={() => remove(a.id)} title="Delete" aria-label="Delete" className="p-1.5 rounded-md text-danger hover:bg-danger-subtle">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {(creating || editing) && (
        <AnnouncementEditor
          announcement={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onSaved={() => { setCreating(false); setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function AnnouncementEditor({ announcement, onClose, onSaved }: { announcement: Announcement | null; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(announcement?.title ?? '');
  const [body, setBody] = useState(announcement?.body ?? '');
  const [severity, setSeverity] = useState(announcement?.severity ?? 'info');
  const [audience, setAudience] = useState(announcement?.audience ?? 'all');
  const [pinned, setPinned] = useState(announcement?.pinned ?? false);
  const [published, setPublished] = useState(announcement?.published ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!title.trim() || !body.trim()) { setError('Title and body are required.'); return; }
    setSaving(true);
    setError(null);
    try {
      const payload = { title, body, severity, audience, pinned, published };
      if (announcement) {
        await adminFetch(`/api/admin/announcements/${announcement.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      } else {
        await adminFetch('/api/admin/announcements', { method: 'POST', body: JSON.stringify(payload) });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-surface rounded-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-line sticky top-0 bg-surface z-10">
          <h2 className="font-bold flex items-center gap-2"><Megaphone className="w-5 h-5" /> {announcement ? 'Edit Announcement' : 'New Announcement'}</h2>
          <button onClick={onClose} className="p-1 text-muted hover:text-secondary"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 space-y-4">
          {error && <ErrorBox message={error} />}
          <div>
            <label className="block text-sm font-medium mb-1.5">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Library closes at 4 pm on Friday"
              className="w-full px-3 py-2 bg-surface-raised border border-line rounded-md text-sm focus:ring-2 focus:ring-ring/25 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">Body</label>
            <RichTextEditor content={body} onChange={setBody} placeholder="e.g. The library will close at 4 pm on Friday for exams." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1.5">Severity</label>
              <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="w-full px-3 py-2 bg-surface-raised border border-line rounded-md text-sm focus:ring-2 focus:ring-ring/25 outline-none">
                <option value="info">Info</option>
                <option value="success">Success</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Audience</label>
              <select value={audience} onChange={(e) => setAudience(e.target.value)} className="w-full px-3 py-2 bg-surface-raised border border-line rounded-md text-sm focus:ring-2 focus:ring-ring/25 outline-none">
                <option value="all">All users</option>
                <option value="students">Students only</option>
                <option value="teachers">Teachers only</option>
              </select>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} className="rounded-sm" />
              Pinned (stays at top)
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} className="rounded-sm" />
              Published
            </label>
          </div>
        </div>
        <div className="p-5 border-t border-line flex justify-end gap-2 sticky bottom-0 bg-surface">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-line rounded-md hover:bg-surface-hover">Cancel</button>
          <button onClick={save} disabled={saving} className="inline-flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50">
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
