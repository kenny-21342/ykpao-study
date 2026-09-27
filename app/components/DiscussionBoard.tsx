'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import dynamic from 'next/dynamic';
import NoticeDialog from './NoticeDialog';
import { useConfirm } from './useConfirm';
import { useScreenContext } from './ScreenContext';
import {
  MessageSquare, ArrowLeft, Loader2, AlertCircle,
  Search, Plus, Eye, Reply, Pin, Lock, Trash2, ChevronRight,
  MessagesSquare, X, Tag, Pencil, ThumbsUp, ThumbsDown, Flag,
} from 'lucide-react';
import { PageHeader } from './ui';

const RichContent = dynamic(() => import('./RichContent'), { ssr: false });
const RichTextEditor = dynamic(() => import('./RichTextEditor'), { ssr: false });

// ----------------------------- Types -----------------------------
type LabelMeta = {
  slug: string;
  name: string;
  badge: string;
  pill: string;
};

type ThreadListItem = {
  id: string;
  subjectId: number | null;
  category: string | null;
  title: string;
  content: string;
  pinned: boolean;
  locked: boolean;
  views: number;
  replyCount: number;
  author: { id: string; name: string | null; image: string | null };
  createdAt: string;
  updatedAt: string;
};

type Post = {
  id: string;
  content: string;
  parentId: string | null;
  hidden?: boolean;
  upvotes?: number;
  downvotes?: number;
  createdAt: string;
  updatedAt: string;
  author: { id: string; name: string | null; image: string | null };
};

type ThreadDetail = {
  id: string;
  title: string;
  content: string;
  pinned: boolean;
  locked: boolean;
  hidden?: boolean;
  views: number;
  upvotes?: number;
  downvotes?: number;
  createdAt: string;
  updatedAt: string;
  author: { id: string; name: string | null; image: string | null };
  category: string | null;
  subject: { id: number; code: string; name: string } | null;
  posts: Post[];
};

type View =
  | { name: 'threads' }
  | { name: 'thread'; threadId: string };

// ----------------------------- Helpers -----------------------------
function fmtDate(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="bg-danger-subtle border border-danger-border rounded-lg p-5 flex items-start gap-3">
      <AlertCircle className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="text-sm font-semibold text-danger">{message}</p>
        {onRetry && <button onClick={onRetry} className="mt-2 text-sm text-danger underline">Try again</button>}
      </div>
    </div>
  );
}

function avatar(name: string | null, image: string | null, size = 'md') {
  const dims = size === 'sm' ? 'w-8 h-8 text-xs' : 'w-10 h-10 text-sm';
  if (image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={image} alt={name ?? 'User'} className={`${dims} rounded-full object-cover`} />
    );
  }
  return (
    <div className={`${dims} rounded-full bg-accent flex items-center justify-center text-white font-bold flex-shrink-0`}>
      {name?.[0]?.toUpperCase() ?? 'A'}
    </div>
  );
}

// Resolve a category slug to its label metadata. Falls back to a neutral
// style for legacy free-text categories that predate the taxonomy.
function labelMeta(slug: string | null | undefined, known: LabelMeta[]): LabelMeta | null {
  if (!slug) return null;
  return known.find((l) => l.slug === slug) ?? null;
}
function legacyMeta(slug: string): LabelMeta {
  return {
    slug,
    name: slug,
    badge: 'bg-surface-raised text-secondary',
    pill: 'bg-surface-inverse text-inverse',
  };
}

// ===================================================================
// Main component
// ===================================================================
export default function DiscussionBoard({
  pendingThreadId,
  onThreadOpened,
}: {
  pendingThreadId?: string | null;
  onThreadOpened?: () => void;
}) {
  const { status } = useSession();
  const [view, setView] = useState<View>({ name: 'threads' });

  // Auto-open a thread when pendingThreadId is set (from notification click).
  useEffect(() => {
    if (pendingThreadId) {
      const timer = window.setTimeout(() => {
        setView({ name: 'thread', threadId: pendingThreadId });
        onThreadOpened?.();
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [pendingThreadId, onThreadOpened]);

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <PageHeader
          title="Discussion Board"
          description="Ask questions, share insights, and discuss with the community."
        />

        {/*
          The board is signed-in only. Checking here keeps a signed-out visitor
          from firing reads that can only 401 and then showing them a failure
          banner, which reads as the board being broken rather than private.

          'loading' deliberately does not fall through to the signed-out
          branch: a signed-in user must never be shown a "sign in" prompt while
          their session is still resolving.
        */}
        {status === 'loading' && (
          <div className="flex items-center justify-center py-16 text-muted">
            <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading…
          </div>
        )}

        {status === 'unauthenticated' && (
          <div className="rounded-lg border border-line bg-surface px-6 py-12 text-center">
            <MessagesSquare className="w-10 h-10 mx-auto text-muted" />
            <h3 className="mt-4 text-lg font-semibold text-primary">
              Sign in to join the discussion
            </h3>
            <p className="mt-1 text-secondary">
              The board is open to signed-in members of the school community.
            </p>
            <a
              href="/auth/login"
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-2.5 font-medium text-white transition-colors hover:bg-accent-hover"
            >
              Sign in
            </a>
          </div>
        )}

        {status === 'authenticated' && view.name === 'threads' && (
          <ThreadsView
            onOpen={(threadId) => setView({ name: 'thread', threadId })}
          />
        )}
        {status === 'authenticated' && view.name === 'thread' && (
          <ThreadView
            threadId={view.threadId}
            onBack={() => setView({ name: 'threads' })}
          />
        )}
      </div>
    </div>
  );
}

// ===================================================================
// Threads view (list + search + create) — single general forum
// ===================================================================
function ThreadsView({ onOpen }: { onOpen: (threadId: string) => void }) {
  const [threads, setThreads] = useState<ThreadListItem[]>([]);
  const [labels, setLabels] = useState<LabelMeta[]>([]);
  const [legacyCategories, setLegacyCategories] = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (activeCategory) params.set('category', activeCategory);
      const res = await fetch(`/api/discussions/threads?${params}`);
      if (!res.ok) throw new Error('Failed to load threads');
      const data = await res.json();
      setThreads(data.threads ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load threads');
    } finally {
      setLoading(false);
    }
  }, [query, activeCategory]);

  // Load labels + legacy category list once
  useEffect(() => {
    fetch('/api/discussions/forums')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        if (Array.isArray(d.labels)) setLabels(d.labels);
        if (Array.isArray(d.categories)) setLegacyCategories(d.categories);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return (
    <div className="space-y-4">
      {/* Header + actions */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-primary">General Discussion</h3>
          <p className="text-xs text-muted">{threads.length} thread{threads.length === 1 ? '' : 's'}</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all"
        >
          <Plus className="w-4 h-4" /> New Thread
        </button>
      </div>

      {/* Search + label filter */}
      <div className="flex flex-col gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. inheritance, 0610-S25-P21-Q2, or momentum"
            className="w-full pl-10 pr-4 py-2.5 bg-surface border border-strong rounded-lg text-sm text-primary focus:ring-2 focus:ring-ring/25 focus:border-transparent outline-none"
          />
        </div>
        {(labels.length > 0 || legacyCategories.length > 0) && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            <span className="hidden md:inline-flex items-center gap-1 text-xs font-semibold text-muted uppercase tracking-wide pr-1">
              <Tag className="w-3.5 h-3.5" />
            </span>
            <button
              onClick={() => setActiveCategory('')}
              className={`text-xs px-3 py-1.5 rounded-full whitespace-nowrap transition-colors ${
                activeCategory === ''
                  ? 'bg-accent text-white'
                  : 'bg-surface-raised text-secondary hover:bg-surface-active'
              }`}
            >
              All
            </button>
            {labels.map((l) => {
              const active = activeCategory === l.slug;
              return (
                <button
                  key={l.slug}
                  onClick={() => setActiveCategory((cur) => (cur === l.slug ? '' : l.slug))}
                  className={`text-xs px-3 py-1.5 rounded-full whitespace-nowrap transition-colors capitalize ${
                    active
                      ? l.pill
                      : 'bg-surface-raised text-secondary hover:bg-surface-active'
                  }`}
                >
                  {l.name}
                </button>
              );
            })}
            {legacyCategories.map((c) => {
              const active = activeCategory === c;
              return (
                <button
                  key={c}
                  onClick={() => setActiveCategory((cur) => (cur === c ? '' : c))}
                  className={`text-xs px-3 py-1.5 rounded-full whitespace-nowrap transition-colors ${
                    active
                      ? 'bg-surface-inverse text-inverse'
                      : 'bg-surface-raised text-secondary hover:bg-surface-active'
                  }`}
                >
                  {c}
                </button>
              );
            })}
            {activeCategory && (
              <button
                onClick={() => setActiveCategory('')}
                className="ml-1 inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full text-muted hover:text-secondary"
                title="Clear label filter" aria-label="Clear label filter"
              >
                <X className="w-3 h-3" /> Clear
              </button>
            )}
          </div>
        )}
      </div>

      {/* List */}
      {loading && threads.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-muted">
          <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading threads…
        </div>
      ) : error ? (
        <ErrorBanner message={error} onRetry={load} />
      ) : threads.length === 0 ? (
        <div className="bg-surface rounded-lg border border-dashed border-strong p-12 text-center">
          <MessageSquare className="w-12 h-12 mx-auto text-muted mb-3" />
          <h3 className="text-lg font-bold text-primary">No threads yet</h3>
          <p className="text-sm text-muted mt-1">
            {query ? 'Try a different search.' : 'Start the conversation — create the first thread.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {threads.map((t) => {
            const meta = labelMeta(t.category, labels) ?? (t.category ? legacyMeta(t.category) : null);
            return (
            <button
              key={t.id}
              onClick={() => onOpen(t.id)}
              className="w-full text-left bg-surface rounded-lg border border-line hover:border-accent-border transition-all p-4 flex items-center gap-4"
            >
              <div className="flex-shrink-0">
                {avatar(t.author.name, t.author.image, 'sm')}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  {t.pinned && <Pin className="w-3.5 h-3.5 text-warning fill-warning flex-shrink-0" />}
                  {t.locked && <Lock className="w-3.5 h-3.5 text-danger flex-shrink-0" />}
                  <h4 className="font-semibold text-primary truncate">{t.title}</h4>
                  {meta && (
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-md flex-shrink-0 ${meta.badge}`}>
                      {meta.name}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted mt-0.5 truncate">
                  by {t.author.name ?? 'Anonymous'} • {fmtDate(t.createdAt)}
                </p>
              </div>
              <div className="flex items-center gap-5 flex-shrink-0 text-xs text-muted">
                <span className="inline-flex items-center gap-1"><Reply className="w-3.5 h-3.5" /> {t.replyCount}</span>
                <span className="inline-flex items-center gap-1"><Eye className="w-3.5 h-3.5" /> {t.views}</span>
                <ChevronRight className="w-4 h-4 text-muted" />
              </div>
            </button>
            );
          })}
        </div>
      )}

      {/* Create thread dialog */}
      {showCreate && (
        <CreateThreadDialog
          labels={labels}
          onClose={() => setShowCreate(false)}
          onCreated={(thread) => {
            setShowCreate(false);
            onOpen(thread.id);
          }}
        />
      )}
    </div>
  );
}

function CreateThreadDialog({ labels, onClose, onCreated }: { labels: LabelMeta[]; onClose: () => void; onCreated: (t: { id: string }) => void }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/discussions/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          content,
          category: category || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create thread');
      onCreated(data.thread);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create thread');
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-surface rounded-lg shadow-overlay w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-line flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-primary">New Thread</h2>
            <p className="text-xs text-muted mt-0.5">General Discussion</p>
          </div>
          <button onClick={onClose} className="p-2 text-muted hover:text-secondary hover:bg-surface-hover rounded-md transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-secondary mb-1.5">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Help with 0610-S25-P21-Q2"
              className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm focus:ring-2 focus:ring-ring/25 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-secondary mb-1.5">Label</label>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setCategory('')}
                className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
                  category === ''
                    ? 'bg-accent text-white'
                    : 'bg-surface-raised text-secondary hover:bg-surface-active'
                }`}
              >
                None
              </button>
              {labels.map((l) => {
                const active = category === l.slug;
                return (
                  <button
                    key={l.slug}
                    type="button"
                    onClick={() => setCategory(l.slug)}
                    className={`text-xs px-3 py-1.5 rounded-full transition-colors ${
                      active ? l.pill : 'bg-surface-raised text-secondary hover:bg-surface-active'
                    }`}
                  >
                    {l.name}
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-muted mt-1">Pick a label so others can find your thread.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-secondary mb-1.5">Body (optional)</label>
            <RichTextEditor
              content={content}
              onChange={setContent}
              placeholder="Explain the question, what you tried, and where you are stuck."
            />
          </div>
          {error && <ErrorBanner message={error} />}
        </div>
        <div className="px-6 py-4 border-t border-line flex items-center justify-end gap-3">
          <button onClick={onClose} disabled={submitting} className="px-4 py-2.5 text-sm font-medium text-secondary bg-surface-raised hover:bg-surface-active rounded-lg transition-colors disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={submitting || !title.trim()}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {submitting ? 'Creating…' : 'Create Thread'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ===================================================================
// Thread view (detail + posts + reply)
// ===================================================================
function ThreadView({ threadId, onBack }: { threadId: string; onBack: () => void }) {
  const { confirm, prompt, confirmDialog } = useConfirm();
  /** A vote is not worth a modal; it gets an inline line instead. */
  const [voteError, setVoteError] = useState<string | null>(null);
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  // Resolved by the server in the session callback, not re-derived here: a
  // bootstrap admin (ADMIN_EMAILS) has role 'student', so comparing role
  // strings hid moderation from someone the server lets moderate.
  const canModerate = session?.user?.canModerate ?? false;
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  // The open thread, so "what do you think of this?" has a referent.
  const { updateData } = useScreenContext();
  useEffect(() => {
    updateData({
      threadTitle: thread?.title,
      threadSubject: thread?.subject?.code ?? undefined,
    });
  }, [thread, updateData]);
  useEffect(() => () => {
    updateData({ threadTitle: undefined, threadSubject: undefined });
  }, [updateData]);
  const [labels, setLabels] = useState<LabelMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title: string; message: string; tone?: 'info' | 'success' | 'warning' | 'error' } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/discussions/threads/${threadId}`);
      if (!res.ok) throw new Error('Failed to load thread');
      const data = await res.json();
      setThread(data.thread);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load thread');
    } finally {
      setLoading(false);
    }
  }, [threadId]);

  // Load labels once for badge styling.
  useEffect(() => {
    fetch('/api/discussions/forums')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.labels) setLabels(d.labels); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const handleReply = async () => {
    if (!reply.trim()) return;
    setPosting(true);
    setPostError(null);
    try {
      const res = await fetch(`/api/discussions/threads/${threadId}/posts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: reply.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to post reply');
      setThread((cur) => cur ? { ...cur, posts: [...cur.posts, data.post] } : cur);
      setReply('');
    } catch (e) {
      setPostError(e instanceof Error ? e.message : 'Failed to post reply');
    } finally {
      setPosting(false);
    }
  };

  const startEdit = (post: Post) => {
    setEditingId(post.id);
    setEditDraft(post.content);
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft('');
    setEditError(null);
  };

  const handleEditSave = async (postId: string) => {
    if (!editDraft.trim()) return;
    setSavingEdit(true);
    setEditError(null);
    try {
      const res = await fetch(`/api/discussions/threads/${threadId}/posts/${postId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editDraft.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save edit');
      setThread((cur) => cur
        ? { ...cur, posts: cur.posts.map((p) => (p.id === postId ? { ...p, ...data.post } : p)) }
        : cur);
      cancelEdit();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : 'Failed to save edit');
    } finally {
      setSavingEdit(false);
    }
  };

  const canDeleteThread =
    !!thread && (canModerate || (!!currentUserId && currentUserId === thread.author.id));

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete this thread?',
      message: 'Every reply on it goes too, including other people\u2019s. This cannot be undone.',
      confirmLabel: 'Delete thread',
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/discussions/threads/${threadId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete');
      }
      onBack();
    } catch (e) {
      setNotice({
        title: 'Delete failed',
        message: e instanceof Error ? e.message : 'The thread could not be deleted.',
        tone: 'error',
      });
    }
  };

  // --- Voting + flagging --------------------------------------------------
  const voteOnPost = async (postId: string, direction: 1 | -1) => {
    try {
      const res = await fetch(`/api/discussions/threads/${threadId}/posts/${postId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction }),
      });
      // A vote that silently does nothing reads as a broken button: the count
      // does not move, and there is no way to tell a rejected vote from a lost
      // request. Both now say so, quietly -- a vote is not worth a modal.
      if (!res.ok) {
        setVoteError('Your vote did not go through. Try again in a moment.');
        return;
      }
      setVoteError(null);
      const data = await res.json();
      setThread((prev) => prev ? {
        ...prev,
        posts: prev.posts.map((p) => p.id === postId ? { ...p, upvotes: data.upvotes, downvotes: data.downvotes } : p),
      } : null);
    } catch {
      setVoteError('Your vote did not go through. Check your connection and try again.');
    }
  };

  const voteOnThread = async (direction: 1 | -1) => {
    try {
      const res = await fetch(`/api/discussions/threads/${threadId}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction }),
      });
      if (!res.ok) {
        setVoteError('Your vote did not go through. Try again in a moment.');
        return;
      }
      setVoteError(null);
      const data = await res.json();
      setThread((prev) => prev ? { ...prev, upvotes: data.upvotes, downvotes: data.downvotes } : null);
    } catch {
      setVoteError('Your vote did not go through. Check your connection and try again.');
    }
  };

  const flagPost = async (postId: string) => {
    const reason = await prompt({
      title: 'Report this post',
      message: 'A moderator reads every report. Tell them what is wrong with it.',
      inputLabel: 'Reason',
      inputPlaceholder: 'Spam, abuse, off-topic…',
      confirmLabel: 'Send report',
    });
    if (!reason) return;
    try {
      const res = await fetch('/api/discussions/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId, reason }),
      });
      if (res.ok) {
        setNotice({ title: 'Reported', message: 'Thank you. A moderator will review this post.', tone: 'success' });
      } else if (res.status === 409) {
        setNotice({ title: 'Already reported', message: 'You have already flagged this post.', tone: 'info' });
      } else {
        // Success pops a dialog, so failure must too -- otherwise reporting
        // something abusive looks exactly like reporting it successfully.
        setNotice({ title: 'Report not sent', message: 'Something went wrong. Please try again.', tone: 'error' });
      }
    } catch {
      setNotice({ title: 'Report not sent', message: 'Check your connection and try again.', tone: 'error' });
    }
  };

  const flagThread = async () => {
    const reason = await prompt({
      title: 'Report this thread',
      message: 'A moderator reads every report. Tell them what is wrong with it.',
      inputLabel: 'Reason',
      inputPlaceholder: 'Spam, abuse, off-topic…',
      confirmLabel: 'Send report',
    });
    if (!reason) return;
    try {
      const res = await fetch('/api/discussions/flags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId, reason }),
      });
      if (res.ok) {
        setNotice({ title: 'Reported', message: 'Thank you. A moderator will review this thread.', tone: 'success' });
      } else if (res.status === 409) {
        setNotice({ title: 'Already reported', message: 'You have already flagged this thread.', tone: 'info' });
      } else {
        setNotice({ title: 'Report not sent', message: 'Something went wrong. Please try again.', tone: 'error' });
      }
    } catch {
      setNotice({ title: 'Report not sent', message: 'Check your connection and try again.', tone: 'error' });
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading thread…
      </div>
    );
  }
  if (error || !thread) {
    return (
      <div className="space-y-4">
        <button onClick={onBack} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-secondary bg-surface border border-strong rounded-lg hover:bg-surface-hover transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back to threads
        </button>
        <ErrorBanner message={error ?? 'Thread not found'} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Breadcrumb */}
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-secondary bg-surface border border-strong rounded-lg hover:bg-surface-hover transition-colors"
        >
          <ArrowLeft className="w-4 h-4" /> All threads
        </button>
        {(() => {
          const meta = labelMeta(thread.category, labels) ?? (thread.category ? legacyMeta(thread.category) : null);
          if (!meta) return null;
          return (
            <span className={`text-xs font-medium px-2 py-1 rounded-md ${meta.badge}`}>
              {meta.name}
            </span>
          );
        })()}
      </div>

      {/* Original post */}
      <div className="bg-surface rounded-lg border border-line overflow-hidden">
        <div className="px-5 py-4 border-b border-subtle flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {thread.pinned && <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 bg-warning-subtle text-warning rounded-md"><Pin className="w-3 h-3" /> Pinned</span>}
              {thread.locked && <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 bg-danger-subtle text-danger rounded-md"><Lock className="w-3 h-3" /> Locked</span>}
              <h2 className="text-xl font-bold text-primary">{thread.title}</h2>
            </div>
            <p className="text-xs text-muted mt-1">
              by {thread.author.name ?? 'Anonymous'} • {fmtDate(thread.createdAt)}
            </p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => voteOnThread(1)}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-accent-text transition-colors rounded-sm"
              title="Upvote" aria-label="Upvote"
            >
              <ThumbsUp className="w-3.5 h-3.5" /> {(thread.upvotes ?? 0) > 0 && thread.upvotes}
            </button>
            <button
              onClick={() => voteOnThread(-1)}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-danger transition-colors rounded-sm"
              title="Downvote" aria-label="Downvote"
            >
              <ThumbsDown className="w-3.5 h-3.5" /> {(thread.downvotes ?? 0) > 0 && thread.downvotes}
            </button>
            <button
              onClick={flagThread}
              className="p-1.5 text-muted hover:text-warning hover:bg-warning-subtle rounded-sm transition-colors"
              title="Report this thread" aria-label="Report this thread"
            >
              <Flag className="w-3.5 h-3.5" />
            </button>
            {/* Gated the same way Edit already is. Rendering this to everyone
                invited non-owners to click Delete, confirm a destructive
                action, and only then be told by the server they can't. */}
            {canDeleteThread && (
              <button
                onClick={handleDelete}
                className="p-1.5 text-muted hover:text-danger hover:bg-danger-subtle rounded-sm transition-colors"
                title="Delete thread" aria-label="Delete thread"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
        <div className="px-5 py-4">
          <div className="prose prose-sm max-w-none text-primary">
            {thread.content ? <RichContent html={thread.content} /> : <p className="text-muted italic">No body.</p>}
          </div>
          <div className="flex items-center gap-4 mt-4 text-xs text-muted">
            <span className="inline-flex items-center gap-1"><Eye className="w-3.5 h-3.5" /> {thread.views} views</span>
            <span className="inline-flex items-center gap-1"><Reply className="w-3.5 h-3.5" /> {thread.posts.length} replies</span>
          </div>
        </div>
      </div>

      {/* Replies */}
      <div className="space-y-3">
        <h3 className="text-sm font-bold text-muted uppercase tracking-wide">
          {thread.posts.length} {thread.posts.length === 1 ? 'Reply' : 'Replies'}
        </h3>

        {thread.posts.length === 0 ? (
          <p className="text-sm text-muted italic py-4">No replies yet. Be the first to respond.</p>
        ) : (
          thread.posts.map((post) => {
            const isOwner = !!currentUserId && currentUserId === post.author.id;
            const isEditing = editingId === post.id;
            const edited = new Date(post.updatedAt).getTime() > new Date(post.createdAt).getTime();
            return (
              <div key={post.id} className="bg-surface rounded-lg border border-line p-4 flex gap-4">
                <div className="flex-shrink-0">{avatar(post.author.name, post.author.image, 'sm')}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs">
                      <span className="font-semibold text-secondary">{post.author.name ?? 'Anonymous'}</span>
                      <span className="text-muted"> · {fmtDate(post.createdAt)}</span>
                      {edited && <span className="text-muted italic"> · edited</span>}
                    </p>
                    <div className="flex items-center gap-3">
                      {isOwner && !isEditing && (
                        <button
                          onClick={() => startEdit(post)}
                          className="inline-flex items-center gap-1 text-xs text-muted hover:text-accent-text transition-colors"
                          title="Edit your reply" aria-label="Edit your reply"
                        >
                          <Pencil className="w-3.5 h-3.5" /> Edit
                        </button>
                      )}
                      {!isEditing && (
                        <>
                          <button
                            onClick={() => voteOnPost(post.id, 1)}
                            className="inline-flex items-center gap-1 text-xs text-muted hover:text-accent-text transition-colors"
                            title="Upvote" aria-label="Upvote"
                          >
                            <ThumbsUp className="w-3.5 h-3.5" /> {(post.upvotes ?? 0) > 0 && post.upvotes}
                          </button>
                          <button
                            onClick={() => voteOnPost(post.id, -1)}
                            className="inline-flex items-center gap-1 text-xs text-muted hover:text-danger transition-colors"
                            title="Downvote" aria-label="Downvote"
                          >
                            <ThumbsDown className="w-3.5 h-3.5" /> {(post.downvotes ?? 0) > 0 && post.downvotes}
                          </button>
                          <button
                            onClick={() => flagPost(post.id)}
                            className="inline-flex items-center gap-1 text-xs text-muted hover:text-warning transition-colors"
                            title="Report this post" aria-label="Report this post"
                          >
                            <Flag className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {isEditing ? (
                    <div className="mt-2 space-y-2">
                      <RichTextEditor
                        content={editDraft}
                        onChange={setEditDraft}
                        placeholder="Revise your reply with the corrected working."
                      />
                      {editError && <p className="text-xs text-danger">{editError}</p>}
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={cancelEdit}
                          disabled={savingEdit}
                          className="px-3 py-1.5 text-xs font-medium text-secondary bg-surface-raised hover:bg-surface-active rounded-md transition-colors disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleEditSave(post.id)}
                          disabled={savingEdit || !editDraft.trim()}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-accent rounded-md shadow transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          {savingEdit && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                          {savingEdit ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="prose prose-sm max-w-none text-primary mt-1.5">
                      <RichContent html={post.content} />
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Reply box */}
      {thread.locked ? (
        <div className="bg-surface-raised border border-line rounded-lg p-4 text-sm text-muted flex items-center gap-2">
          <Lock className="w-4 h-4" /> This thread is locked. New replies are disabled.
        </div>
      ) : (
        <div className="bg-surface rounded-lg border border-line p-4 space-y-3">
          <label className="block text-sm font-medium text-secondary">Post a reply</label>
          <RichTextEditor
            content={reply}
            onChange={setReply}
            placeholder="Add your answer, correction, or follow-up."
          />
          {postError && <ErrorBanner message={postError} />}
          <div className="flex justify-end">
            <button
              onClick={handleReply}
              disabled={posting || !reply.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {posting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Reply className="w-4 h-4" />}
              {posting ? 'Posting…' : 'Post Reply'}
            </button>
          </div>
        </div>
      )}

      {voteError && (
        <p className="mb-3 rounded-md bg-warning-subtle px-3 py-2 text-xs text-warning">
          {voteError}
        </p>
      )}

      {confirmDialog}

      <NoticeDialog
        open={notice !== null}
        title={notice?.title ?? ''}
        message={notice?.message ?? ''}
        tone={notice?.tone ?? 'info'}
        onClose={() => setNotice(null)}
      />
    </div>
  );
}
