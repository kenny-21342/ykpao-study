'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import {
  Users, Search, Loader2, AlertCircle, BookOpen, FileText,
  Download, Eye, Plus, X, Clock, Tag, Star,
  Library, Sparkles, Heart, MessageCircle, ArrowUpDown, ChevronLeft, ChevronRight,
  Paperclip, Upload, Trash2, FolderUp, CheckCircle2, XCircle, File as FileIcon,
  Folder, FolderOpen, Home,
} from 'lucide-react';
import { sanitizeHtml } from '@/lib/sanitize-html';

const FormattedMessage = dynamic(() => import('./FormattedMessage'), { ssr: false });
const RichTextEditor = dynamic(() => import('./RichTextEditor'), { ssr: false });

// Metadata for a non-image file attached to a shared note. Image uploads
// are embedded inline in `content`; documents live here as attachments.
type Attachment = {
  url: string;
  name: string;
  type: string;
  size: number;
};

// ----------------------------- Types -----------------------------
type SharedNoteListItem = {
  id: string;
  title: string;
  content: string;
  subject: string | null;
  courseCode: string | null;
  tags: string[];
  visibility: string;
  attachments?: Attachment[];
  views: number;
  createdAt: string;
  updatedAt: string;
  author: { id: string; name: string | null; image: string | null };
  commentCount: number;
  ratingCount: number;
};

type Tab = 'notes' | 'school';

type ExternalNote = {
  id: string;
  title: string;
  link: string;
  author: string;
  categories: string[];
  pubDate: string;
  excerpt: string;
  content: string;
  publishedAt?: string;
  reads?: number;
  upvotes?: number;
  commentCount?: number;
};

// ===================================================================
// Component
// ===================================================================
export default function ResourceLibrary() {
  const [tab, setTab] = useState<Tab>('notes');
  const [scope, setScope] = useState<'enrolled' | 'all'>('enrolled');
  useEffect(() => {
    const stored = window.localStorage.getItem('scope:resources');
    if (stored === 'all' || stored === 'enrolled') window.setTimeout(() => setScope(stored), 0);
  }, []);

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Library className="w-6 h-6 text-green-600" />
            Resource Library
          </h2>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            Discover shared study notes from the community and school resources.
          </p>
          <div className="mt-3 inline-flex rounded-xl border border-gray-200 bg-white p-1 dark:border-gray-700 dark:bg-gray-800" role="group" aria-label="Resource scope">
            <button type="button" onClick={() => { setScope('enrolled'); window.localStorage.setItem('scope:resources', 'enrolled'); }} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${scope === 'enrolled' ? 'bg-green-600 text-white' : 'text-gray-600 dark:text-gray-300'}`}>My courses</button>
            <button type="button" onClick={() => { setScope('all'); window.localStorage.setItem('scope:resources', 'all'); }} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${scope === 'all' ? 'bg-green-600 text-white' : 'text-gray-600 dark:text-gray-300'}`}>All subjects</button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-2 border-b border-gray-200 dark:border-gray-700">
          <TabButton active={tab === 'notes'} onClick={() => setTab('notes')} icon={<Users className="w-4 h-4" />}>
            Shared Notes
          </TabButton>
          <TabButton active={tab === 'school'} onClick={() => setTab('school')} icon={<Library className="w-4 h-4" />}>
            School Resources
          </TabButton>
        </div>

        {tab === 'notes' ? <SharedNotesTab scope={scope} /> : <SchoolResourcesTab scope={scope} />}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors ${
        active
          ? 'border-green-600 text-green-700 dark:text-green-400'
          : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl p-5 flex items-start gap-3">
      <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="text-sm font-semibold text-red-800 dark:text-red-300">{message}</p>
        {onRetry && (
          <button onClick={onRetry} className="mt-2 text-sm text-red-700 underline">Try again</button>
        )}
      </div>
    </div>
  );
}

function fmtSize(bytes: number) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ===================================================================
// Shared Notes tab
// ===================================================================
type NoteDetail = {
  id: string;
  title: string;
  content: string;
  subject: string | null;
  courseCode: string | null;
  tags: string[];
  visibility: string;
  attachments?: Attachment[];
  views: number;
  createdAt: string;
  updatedAt: string;
  author: { id: string; name: string | null; image: string | null };
  comments: Array<{
    id: string;
    content: string;
    createdAt: string;
    user: { id: string; name: string | null; image: string | null };
  }>;
  avgRating: number | null;
  ratingCount: number;
};

function SharedNotesTab({ scope }: { scope: 'enrolled' | 'all' }) {
  const [subTab, setSubTab] = useState<'community' | 'ykpao'>('ykpao');

  return (
    <div className="space-y-5">
      {/* Sub-tab toggle */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => setSubTab('ykpao')}
          className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg transition-colors ${
            subTab === 'ykpao'
              ? 'bg-green-600 text-white shadow'
              : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-600 hover:border-green-400'
          }`}
        >
          <BookOpen className="w-4 h-4" /> YKPao Review
        </button>
        <button
          onClick={() => setSubTab('community')}
          className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold rounded-lg transition-colors ${
            subTab === 'community'
              ? 'bg-green-600 text-white shadow'
              : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-600 hover:border-green-400'
          }`}
        >
          <Users className="w-4 h-4" /> Community
        </button>
      </div>

      {subTab === 'ykpao' ? <ExternalNotesView /> : <CommunityNotesView scope={scope} />}
    </div>
  );
}

// ===================================================================
// External notes (from review.ykpao.com via RSS + scraping)
// ===================================================================
function ExternalNotesView() {
  const [notes, setNotes] = useState<ExternalNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ExternalNote | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  // Load RSS metadata only (fast — no page scraping)
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/external-notes?limit=100&content=false');
      if (res.status === 401) throw new Error('Sign in to read the shared notes library.');
      if (res.status === 429) throw new Error('Too many requests — please wait a moment and retry.');
      if (!res.ok) throw new Error('Failed to load notes');
      const data = await res.json();
      setNotes(data.notes ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load notes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Fetch full content for a single post on demand (avoids pulling all 100)
  const openNote = async (note: ExternalNote) => {
    setSelected(note);
    if (note.content) return; // already have content
    setLoadingContent(true);
    try {
      const res = await fetch(`/api/external-notes?url=${encodeURIComponent(note.link)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.note?.content) setSelected(data.note as ExternalNote);
    } catch {
      // keep the RSS-only version
    } finally {
      setLoadingContent(false);
    }
  };

  const filtered = notes.filter((n) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return n.title.toLowerCase().includes(q) || n.excerpt.toLowerCase().includes(q);
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Fetching posts from YKPao Review…
      </div>
    );
  }
  if (error) return <ErrorBanner message={error} onRetry={load} />;

  return (
    <>
      {/* Search */}
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. exam tips, revision, or Biology"
          className="w-full pl-10 pr-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
        />
      </div>

      <div className="flex items-center gap-2 text-xs text-gray-400">
        <BookOpen className="w-3.5 h-3.5" />
        <span>Sourced from <a href="https://review.ykpao.com" target="_blank" rel="noopener noreferrer" className="text-green-600 hover:underline">review.ykpao.com</a></span>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-2xl border border-dashed border-gray-300 dark:border-gray-600 p-12 text-center">
          <BookOpen className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">No posts found</h3>
          <p className="text-sm text-gray-500 mt-1">Try a different search.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((note) => (
            <ExternalNoteCard key={note.id} note={note} onOpen={() => openNote(note)} />
          ))}
        </div>
      )}

      {selected && (
        <ExternalNoteReader note={selected} onClose={() => setSelected(null)} loadingContent={loadingContent} />
      )}
    </>
  );
}

function ExternalNoteCard({ note, onOpen }: { note: ExternalNote; onOpen: () => void }) {
  const showStats = note.reads != null || note.upvotes != null;
  return (
    <button
      onClick={onOpen}
      className="text-left bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm hover:shadow-md hover:border-green-300 transition-all p-5 flex flex-col"
    >
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-green-500 to-emerald-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
          {note.author[0]?.toUpperCase() ?? 'K'}
        </div>
        <span className="text-xs text-gray-500 truncate">{note.author}</span>
        <span className="text-xs text-gray-400 ml-auto">
          {new Date(note.publishedAt ?? note.pubDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      </div>

      <h3 className="font-bold text-gray-900 dark:text-gray-100 mt-3 line-clamp-2">{note.title}</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 line-clamp-3 flex-1">{note.excerpt}</p>

      {note.categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {note.categories.slice(0, 3).map((c, i) => (
            <span key={i} className="text-xs px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-md">
              {c}
            </span>
          ))}
        </div>
      )}

      {showStats && (
        <div className="flex items-center gap-3 mt-3 pt-3 border-t border-gray-100 dark:border-gray-700 text-xs text-gray-400">
          {note.reads != null && (
            <span className="inline-flex items-center gap-1" title="Views">
              <Eye className="w-3.5 h-3.5" /> {fmtCompact(note.reads)}
            </span>
          )}
          {note.upvotes != null && (
            <span className="inline-flex items-center gap-1" title="Likes">
              <Heart className="w-3.5 h-3.5" /> {note.upvotes}
            </span>
          )}
        </div>
      )}
    </button>
  );
}

/** 284805 → "284.8K", 5 → "5" */
function fmtCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function ExternalNoteReader({ note, onClose, loadingContent }: { note: ExternalNote; onClose: () => void; loadingContent?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-500">by {note.author}</span>
              <span className="text-xs text-gray-400">· {new Date(note.pubDate).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</span>
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mt-1">{note.title}</h2>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a
              href={note.link}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 text-gray-400 hover:text-green-600 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              title="Open original"
            >
              <Eye className="w-5 h-5" />
            </a>
            <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Post stats bar */}
          <div className="flex flex-wrap items-center gap-4 mb-4 pb-3 border-b border-gray-100 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
            <span className="inline-flex items-center gap-1" title="Published">
              <Clock className="w-3.5 h-3.5" />
              {new Date(note.publishedAt ?? note.pubDate).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
            </span>
            {note.reads != null && (
              <span className="inline-flex items-center gap-1" title="Views">
                <Eye className="w-3.5 h-3.5" /> {note.reads.toLocaleString()}
              </span>
            )}
            {note.upvotes != null && (
              <span className="inline-flex items-center gap-1" title="Likes">
                <Heart className="w-3.5 h-3.5" /> {note.upvotes}
              </span>
            )}
            {note.commentCount != null && (
              <span className="inline-flex items-center gap-1" title="Comments">
                <MessageCircle className="w-3.5 h-3.5" /> {note.commentCount}
              </span>
            )}
          </div>

          {note.categories.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {note.categories.map((c, i) => (
                <span key={i} className="text-xs px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-md">
                  {c}
                </span>
              ))}
            </div>
          )}
          {note.content ? (
            <div
              className="prose prose-sm max-w-none text-gray-800 dark:text-gray-200 [&_p]:my-2 [&_ul]:my-2 [&_li]:ml-4 [&_li]:list-disc [&_h1]:text-lg [&_h1]:font-bold [&_h2]:text-base [&_h2]:font-semibold [&_a]:text-blue-600 [&_a]:underline hover:[&_a]:text-blue-800 [&_img]:rounded-lg [&_img]:max-w-full"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(note.content) }}
            />
          ) : loadingContent ? (
            <div className="flex items-center justify-center py-12 text-gray-400">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading content…
            </div>
          ) : (
            <p className="text-sm text-gray-400 italic">No content available. <a href={note.link} target="_blank" rel="noopener noreferrer" className="text-green-600 underline">View original →</a></p>
          )}

          {/* Comment notice */}
          {note.commentCount == null && (
            <div className="mt-6 p-3 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-xl text-xs text-gray-500 dark:text-gray-400 flex items-center gap-2">
              <MessageCircle className="w-4 h-4 flex-shrink-0" />
              <span>
                Comments are loaded on the original site (require its own login).
                <a href={`${note.link}#comment`} target="_blank" rel="noopener noreferrer" className="ml-1 text-green-600 underline">View comments on YKPao Review →</a>
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ===================================================================
// Community notes (internal, from /api/shared-notes)
// ===================================================================
function CommunityNotesView({ scope }: { scope: 'enrolled' | 'all' }) {
  const [notes, setNotes] = useState<SharedNoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('');
  const [courseFilter, setCourseFilter] = useState('');
  const [activeTag, setActiveTag] = useState('');
  const [subjects, setSubjects] = useState<string[]>([]);
  const [selected, setSelected] = useState<NoteDetail | null>(null);
  const [showPublish, setShowPublish] = useState(false);
  const [showFilterUI, setShowFilterUI] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (subjectFilter) params.set('subject', subjectFilter);
      if (courseFilter.trim()) params.set('courseCode', courseFilter.trim());
      if (activeTag) params.set('tag', activeTag);
      params.set('scope', scope);
      const res = await fetch(`/api/shared-notes?${params}`);
      // 401 is not a failure, it is the answer: the library is for signed-in
      // members. Reporting it as a load error tells the visitor the page is
      // broken when it is working exactly as intended.
      if (res.status === 401) throw new Error('Sign in to browse community notes.');
      if (!res.ok) throw new Error('Failed to load shared notes');
      const data = await res.json();
      setNotes(data.notes ?? []);
      if (Array.isArray(data.subjects)) setSubjects(data.subjects);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load shared notes');
    } finally {
      setLoading(false);
    }
  }, [query, scope, subjectFilter, courseFilter, activeTag]);

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

  const openNote = async (id: string) => {
    setSelected(null);
    try {
      const res = await fetch(`/api/shared-notes/${id}`);
      if (!res.ok) throw new Error('Failed to load note');
      const data = await res.json();
      setSelected(data.note);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load note');
    }
  };

  // All unique tags across currently loaded notes (for the tag cloud)
  const allTags = Array.from(new Set(notes.flatMap((n) => n.tags))).sort();

  if (loading && notes.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading shared notes…
      </div>
    );
  }
  if (error && notes.length === 0) return <ErrorBanner message={error} onRetry={load} />;

  return (
    <div className="space-y-5">
      {/* Top row: search + actions */}
      <div className="flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. motion, acids, or chapter 4 notes"
            className="w-full pl-10 pr-4 py-2.5 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          />
        </div>
        <button
          onClick={() => setShowFilterUI((v) => !v)}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
        >
          <Tag className="w-4 h-4" /> Filters
        </button>
        <button
          onClick={() => setShowPublish(true)}
          className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-500 rounded-xl shadow hover:shadow-md transition-all"
        >
          <Plus className="w-4 h-4" /> Share a Note
        </button>
      </div>

      {/* Filters panel */}
      {showFilterUI && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
          {subjects.length > 0 && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase mb-1.5">Subject</label>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setSubjectFilter('')}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                    subjectFilter === ''
                      ? 'bg-green-600 text-white border-transparent'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-transparent hover:border-green-400'
                  }`}
                >
                  All
                </button>
                {subjects.map((s) => (
                  <button
                    key={s}
                    onClick={() => setSubjectFilter((cur) => (cur === s ? '' : s))}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      subjectFilter === s
                        ? 'bg-green-600 text-white border-transparent'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-transparent hover:border-green-400'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase mb-1.5">Course code</label>
            <input
              type="text"
              value={courseFilter}
              onChange={(e) => setCourseFilter(e.target.value)}
              placeholder="e.g. PHYS-101"
              className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
            />
          </div>
          {allTags.length > 0 && (
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase mb-1.5">Tag</label>
              <div className="flex flex-wrap gap-1.5">
                {allTags.map((t) => (
                  <button
                    key={t}
                    onClick={() => setActiveTag((cur) => (cur === t ? '' : t))}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                      activeTag === t
                        ? 'bg-green-600 text-white border-transparent'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-transparent hover:border-green-400'
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
          {(courseFilter || activeTag) && (
            <button
              onClick={() => { setSubjectFilter(''); setCourseFilter(''); setActiveTag(''); }}
              className="text-xs text-gray-500 hover:text-gray-700 inline-flex items-center gap-1"
            >
              <X className="w-3 h-3" /> Clear filters
            </button>
          )}
        </div>
      )}

      {/* Results */}
      {error && <ErrorBanner message={error} onRetry={load} />}

      {notes.length === 0 && !loading ? (
        <div className="bg-white dark:bg-gray-800 rounded-2xl border border-dashed border-gray-300 dark:border-gray-600 p-12 text-center">
          <Users className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">No shared notes found</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-md mx-auto">
            Try adjusting your search, or be the first to share a note with the community.
          </p>
          <button
            onClick={() => setShowPublish(true)}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-500 rounded-xl shadow hover:shadow-md transition-all"
          >
            <Plus className="w-4 h-4" /> Share a Note
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {notes.map((note) => (
            <SharedNoteCard key={note.id} note={note} onOpen={() => openNote(note.id)} />
          ))}
        </div>
      )}

      {/* Reader modal */}
      {selected && (
        <NoteReader note={selected} onClose={() => setSelected(null)} />
      )}

      {/* Publish dialog */}
      {showPublish && (
        <PublishNoteDialog
          onClose={() => setShowPublish(false)}
          onPublished={() => { setShowPublish(false); load(); }}
        />
      )}
    </div>
  );
}

function SharedNoteCard({ note, onOpen }: { note: SharedNoteListItem; onOpen: () => void }) {
  const authorName = note.author.name ?? 'Anonymous';
  const authorInitial = authorName[0]?.toUpperCase() ?? 'A';
  const preview = note.content.replace(/[#*`>\-]/g, '').slice(0, 140);

  return (
    <button
      onClick={onOpen}
      className="text-left bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm hover:shadow-md hover:border-green-300 transition-all p-5 flex flex-col"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-green-500 to-emerald-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
            {note.author.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={note.author.image} alt={authorName} className="w-full h-full rounded-full object-cover" />
            ) : authorInitial}
          </div>
          <span className="text-xs text-gray-500 truncate">{authorName}</span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {note.subject && (
            <span className="text-xs font-semibold px-2 py-0.5 bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 rounded-md">
              {note.subject}
            </span>
          )}
          {note.courseCode && (
            <span className="text-xs font-semibold px-2 py-0.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-md">
              {note.courseCode}
            </span>
          )}
        </div>
      </div>

      <h3 className="font-bold text-gray-900 dark:text-gray-100 mt-3 line-clamp-2">{note.title}</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 line-clamp-3 flex-1">{preview}</p>

      {note.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {note.tags.slice(0, 4).map((t) => (
            <span key={t} className="text-xs px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-md">
              {t}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center gap-4 mt-4 pt-3 border-t border-gray-100 dark:border-gray-700 text-xs text-gray-400">
        <span className="inline-flex items-center gap-1"><Eye className="w-3.5 h-3.5" /> {note.views}</span>
        <span className="inline-flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {fmtDate(note.createdAt)}</span>
        {note.attachments && note.attachments.length > 0 && (
          <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
            <Paperclip className="w-3.5 h-3.5" /> {note.attachments.length}
          </span>
        )}
      </div>
    </button>
  );
}

// ===================================================================
// School Resources tab — staff-uploaded files (worksheets, slides, exams,
// handouts) for the whole school to retrieve. Separate from Shared Notes
// (which are user-authored study notes).
// ===================================================================
type SchoolResource = {
  id: string;
  title: string;
  description: string;
  subject: string | null;
  category: string | null;
  fileUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  downloads: number;
  createdAt: string;
  updatedAt: string;
  uploader: { id: string; name: string | null; image: string | null };
};

type ResourceSort = 'createdAt' | 'updatedAt' | 'title' | 'fileName' | 'downloads' | 'fileSize';
type ResourceSortOrder = 'asc' | 'desc';

type ResourcePageResponse = {
  resources: SchoolResource[];
  total: number;
  page: number;
  totalPages: number;
  subjects?: string[];
  categories?: string[];
};

type ResourceViewMode = 'list' | 'browser';
const FOLDER_UPLOAD_PREFIX = 'From folder upload: ';
const BROWSER_RESOURCE_LIMIT = 1000;

type ResourceBrowserNode = {
  name: string;
  path: string;
  totalFiles: number;
  folders: ResourceBrowserNode[];
  files: SchoolResource[];
  folderMap: Map<string, ResourceBrowserNode>;
};

function createBrowserNode(name: string, path: string): ResourceBrowserNode {
  return {
    name,
    path,
    totalFiles: 0,
    folders: [],
    files: [],
    folderMap: new Map(),
  };
}

function normalizePathSegment(segment: string): string {
  return segment.trim().replace(/\s+/g, ' ');
}

function splitBrowsePath(path: string): string[] {
  return path
    .split('/')
    .map((segment) => normalizePathSegment(segment))
    .filter(Boolean);
}

function stripResourceFileNameFromPath(path: string, resource: SchoolResource): string {
  const segments = splitBrowsePath(path);
  if (segments.length === 0) return '';

  const lastSegment = segments[segments.length - 1].toLowerCase();
  if (lastSegment === resource.fileName.toLowerCase()) {
    return segments.slice(0, -1).join('/');
  }

  return segments.join('/');
}

function deriveBrowsePath(resource: SchoolResource): string {
  const rawDescription = resource.description?.trim() ?? '';
  if (rawDescription.startsWith(FOLDER_UPLOAD_PREFIX)) {
    const folderPath = rawDescription.slice(FOLDER_UPLOAD_PREFIX.length).trim();
    return stripResourceFileNameFromPath(folderPath, resource);
  }

  const parts = [resource.subject?.trim(), resource.category?.trim()].filter((value): value is string => Boolean(value));
  return parts.join('/');
}

function formatResourceDescription(resource: SchoolResource): string {
  const description = resource.description?.trim();
  if (!description) return '—';
  if (!description.startsWith(FOLDER_UPLOAD_PREFIX)) return description;

  const folderPath = deriveBrowsePath(resource);
  return folderPath ? `Folder: ${folderPath}` : 'Folder upload';
}

function buildBrowserTree(resources: SchoolResource[]): ResourceBrowserNode {
  const root = createBrowserNode('All resources', '');

  for (const resource of resources) {
    const path = deriveBrowsePath(resource);
    const segments = splitBrowsePath(path);
    let node = root;
    node.totalFiles += 1;

    if (segments.length === 0) {
      node.files.push(resource);
      continue;
    }

    let currentPath = '';
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let child = node.folderMap.get(segment);
      if (!child) {
        child = createBrowserNode(segment, currentPath);
        node.folderMap.set(segment, child);
        node.folders.push(child);
      }
      node = child;
      node.totalFiles += 1;
    }

    node.files.push(resource);
  }

  const sortNode = (node: ResourceBrowserNode) => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.folders.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

function findBrowserNode(root: ResourceBrowserNode, path: string): ResourceBrowserNode | null {
  if (!path) return root;
  const segments = splitBrowsePath(path);
  let node = root;
  for (const segment of segments) {
    const child = node.folderMap.get(segment);
    if (!child) return null;
    node = child;
  }
  return node;
}

function SchoolResourcesTab({ scope }: { scope: 'enrolled' | 'all' }) {
  const [resources, setResources] = useState<SchoolResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ResourceViewMode>('list');
  const [currentFolderPath, setCurrentFolderPath] = useState('');
  const [query, setQuery] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [sortBy, setSortBy] = useState<ResourceSort>('createdAt');
  const [sortOrder, setSortOrder] = useState<ResourceSortOrder>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(200);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [subjects, setSubjects] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const isBrowserRequest = viewMode === 'browser';
      const limit = isBrowserRequest ? BROWSER_RESOURCE_LIMIT : pageSize;
      const pageForRequest = isBrowserRequest ? 1 : page;
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (subjectFilter) params.set('subject', subjectFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      params.set('sort', sortBy);
      params.set('order', sortOrder);
      params.set('page', String(pageForRequest));
      params.set('limit', String(limit));
      params.set('scope', scope);
      const res = await fetch(`/api/school-resources?${params}`);
      if (res.status === 401) throw new Error('Sign in to browse school resources.');
      if (!res.ok) throw new Error('Failed to load resources');
      const data = await res.json() as ResourcePageResponse;
      const nextTotalPages = Math.max(1, data.totalPages ?? 1);
      setResources(data.resources ?? []);
      setTotal(data.total ?? 0);
      setTotalPages(nextTotalPages);
      setSubjects(data.subjects ?? []);
      setCategories(data.categories ?? []);
      if (page > nextTotalPages) setPage(nextTotalPages);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load resources');
    } finally {
      setLoading(false);
    }
  }, [categoryFilter, page, pageSize, query, scope, sortBy, sortOrder, subjectFilter, viewMode]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void load();
    }, query.trim() ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query, refreshTick, viewMode]);

  const browserTree = useMemo(() => buildBrowserTree(resources), [resources]);
  const browserPath = useMemo(() => (
    currentFolderPath && findBrowserNode(browserTree, currentFolderPath) ? currentFolderPath : ''
  ), [browserTree, currentFolderPath]);
  const browserNode = useMemo(() => findBrowserNode(browserTree, browserPath) ?? browserTree, [browserTree, browserPath]);

  const pageStart = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const pageEnd = total === 0 ? 0 : Math.min(total, pageStart + resources.length - 1);
  const isBrowserView = viewMode === 'browser';
  const subjectOptions = subjects.length > 0
    ? subjects
    : Array.from(new Set(resources.map((r) => r.subject).filter((value): value is string => Boolean(value))));
  const categoryOptions = categories.length > 0
    ? categories
    : Array.from(new Set(resources.map((r) => r.category).filter((value): value is string => Boolean(value))));

  const clearFilters = () => {
    setQuery('');
    setSubjectFilter('');
    setCategoryFilter('');
    setSortBy('createdAt');
    setSortOrder('desc');
    setPage(1);
  };

  const switchViewMode = (mode: ResourceViewMode) => {
    setViewMode(mode);
    setPage(1);
    setCurrentFolderPath('');
  };

  const trackAccess = useCallback((resource: SchoolResource) => {
    void fetch(`/api/school-resources/${resource.id}?download=1`).catch(() => {});
    setResources((current) => current.map((item) => (
      item.id === resource.id ? { ...item, downloads: item.downloads + 1 } : item
    )));
  }, []);

  const openResource = useCallback((resource: SchoolResource) => {
    setOpeningId(resource.id);
    const tab = window.open(resource.fileUrl, '_blank', 'noopener,noreferrer');
    if (tab) tab.opener = null;
    else window.location.href = resource.fileUrl;
    trackAccess(resource);
    window.setTimeout(() => {
      setOpeningId((current) => (current === resource.id ? null : current));
    }, 300);
  }, [trackAccess]);

  return (
    <div className="space-y-4">
      {/* Header + upload */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">School Resources</h3>
          <p className="text-xs text-gray-500">
            {total.toLocaleString()} resource{total === 1 ? '' : 's'} • Browse files by name, subject, folder, or upload date.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-xl border border-gray-200 bg-white p-1 dark:border-gray-700 dark:bg-gray-800">
            <button
              type="button"
              onClick={() => switchViewMode('list')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                !isBrowserView
                  ? 'bg-green-600 text-white shadow-sm'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
              }`}
              title="List view"
            >
              <FileText className="w-4 h-4" />
              List
            </button>
            <button
              type="button"
              onClick={() => switchViewMode('browser')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                isBrowserView
                  ? 'bg-green-600 text-white shadow-sm'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
              }`}
              title="Folder browser"
            >
              <FolderOpen className="w-4 h-4" />
              Browser
            </button>
          </div>
          <button
            onClick={() => setShowUpload(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-500 rounded-xl shadow hover:shadow-md transition-all"
          >
            <Upload className="w-4 h-4" /> Upload Resource
          </button>
        </div>
      </div>

      {/* Search + filters */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(180px,0.8fr)_minmax(180px,0.8fr)_minmax(150px,0.6fr)_minmax(120px,0.5fr)]">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            placeholder="e.g. worksheet, 2024, Biology, or Ms Lee"
            className="w-full pl-10 pr-10 py-2.5 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); setPage(1); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <select
          value={subjectFilter}
          onChange={(e) => { setSubjectFilter(e.target.value); setPage(1); }}
          className="w-full px-3 py-2.5 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-green-500"
        >
          <option value="">All subjects</option>
          {subjectOptions.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }}
          className="w-full px-3 py-2.5 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-green-500"
        >
          <option value="">All categories</option>
          {categoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}
        </select>
        <select
          value={sortBy}
          onChange={(e) => { setSortBy(e.target.value as ResourceSort); setPage(1); }}
          className="w-full px-3 py-2.5 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-green-500"
        >
          <option value="createdAt">Newest first</option>
          <option value="updatedAt">Recently updated</option>
          <option value="title">Title</option>
          <option value="fileName">Filename</option>
          <option value="downloads">Most opened</option>
          <option value="fileSize">File size</option>
        </select>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSortOrder((current) => (current === 'desc' ? 'asc' : 'desc'))}
            className="inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-xl border border-gray-300 bg-white px-3 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
            title="Toggle sort order"
          >
            <ArrowUpDown className="w-4 h-4" />
            {sortOrder === 'desc' ? 'Descending' : 'Ascending'}
          </button>
          <select
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
            className="w-24 px-3 py-2.5 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-green-500"
            title="Rows per page"
          >
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
        </div>
      </div>

      {/* List / Browser */}
      {loading && resources.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-gray-500">
          <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading resources…
        </div>
      ) : error ? (
        <ErrorBanner message={error} onRetry={load} />
      ) : resources.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-2xl border border-dashed border-gray-300 dark:border-gray-600 p-12 text-center">
          <Library className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">No resources yet</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {query || subjectFilter || categoryFilter ? 'Try a different search or filter.' : 'Upload the first school resource.'}
          </p>
          {(query || subjectFilter || categoryFilter) && (
            <button
              onClick={clearFilters}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <X className="w-4 h-4" /> Clear filters
            </button>
          )}
        </div>
      ) : isBrowserView ? (
        <ResourceBrowserView
          node={browserNode}
          currentPath={browserPath}
          onChangePath={setCurrentFolderPath}
          onOpenResource={openResource}
          onDownloadResource={trackAccess}
          openingId={openingId}
          total={total}
          loadLimit={BROWSER_RESOURCE_LIMIT}
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span>{pageStart.toLocaleString()}-{pageEnd.toLocaleString()} of {total.toLocaleString()}</span>
              {loading && <span className="inline-flex items-center gap-1 text-green-600"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Refreshing</span>}
            </div>
            <button
              onClick={clearFilters}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <X className="w-3.5 h-3.5" /> Clear filters
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1120px] w-full border-collapse">
              <thead className="bg-gray-50/80 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:bg-gray-900/60 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-3">File</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Subject</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">
                    <button type="button" onClick={() => { setSortBy('fileSize'); setSortOrder((current) => (sortBy === 'fileSize' ? (current === 'desc' ? 'asc' : 'desc') : 'asc')); setPage(1); }} className="inline-flex items-center gap-1.5">
                      Size <ArrowUpDown className="w-3.5 h-3.5" />
                    </button>
                  </th>
                  <th className="px-4 py-3">
                    <button type="button" onClick={() => { setSortBy('updatedAt'); setSortOrder((current) => (sortBy === 'updatedAt' ? (current === 'desc' ? 'asc' : 'desc') : 'desc')); setPage(1); }} className="inline-flex items-center gap-1.5">
                      Updated <ArrowUpDown className="w-3.5 h-3.5" />
                    </button>
                  </th>
                  <th className="px-4 py-3">
                    <button type="button" onClick={() => { setSortBy('downloads'); setSortOrder((current) => (sortBy === 'downloads' ? (current === 'desc' ? 'asc' : 'desc') : 'desc')); setPage(1); }} className="inline-flex items-center gap-1.5">
                      Opens <ArrowUpDown className="w-3.5 h-3.5" />
                    </button>
                  </th>
                  <th className="px-4 py-3">Uploader</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {resources.map((resource) => (
                  <ResourceRow
                    key={resource.id}
                    resource={resource}
                    onOpen={() => openResource(resource)}
                    onDownload={() => trackAccess(resource)}
                    opening={openingId === resource.id}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-3 border-t border-gray-200 px-4 py-3 text-sm text-gray-500 dark:border-gray-700 sm:flex-row sm:items-center sm:justify-between">
            <p>
              Showing {pageStart.toLocaleString()}-{pageEnd.toLocaleString()} of {total.toLocaleString()}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page <= 1}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <ChevronLeft className="w-4 h-4" /> Prev
              </button>
              <span className="text-xs uppercase tracking-wide text-gray-400">
                Page {page.toLocaleString()} of {totalPages.toLocaleString()}
              </span>
              <button
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={page >= totalPages}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {showUpload && (
        <UploadResourceDialog
          onClose={() => setShowUpload(false)}
          onUploaded={() => {
            setShowUpload(false);
            setPage(1);
            setRefreshTick((tick) => tick + 1);
          }}
        />
      )}
    </div>
  );
}

function ResourceRow({
  resource,
  onOpen,
  onDownload,
  opening,
}: {
  resource: SchoolResource;
  onOpen: () => void;
  onDownload: () => void;
  opening: boolean;
}) {
  const ext = resource.fileName.split('.').pop()?.toUpperCase() ?? 'FILE';
  return (
    <tr className="align-top transition-colors hover:bg-gray-50/70 dark:hover:bg-gray-900/40">
      <td className="px-4 py-3">
        <button type="button" onClick={onOpen} className="flex items-start gap-3 text-left">
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-green-500 to-emerald-500 text-[10px] font-bold text-white">
            {ext}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{resource.title}</span>
            <span className="block truncate text-xs text-gray-500 dark:text-gray-400">{resource.fileName}</span>
          </span>
        </button>
      </td>
      <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
        <p className="max-w-[280px] truncate font-medium">{formatResourceDescription(resource)}</p>
      </td>
      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
        {resource.subject ?? '—'}
      </td>
      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
        {resource.category ?? '—'}
      </td>
      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
        {fmtSize(resource.fileSize)}
      </td>
      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
        {fmtDate(resource.updatedAt)}
      </td>
      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
        {resource.downloads.toLocaleString()}
      </td>
      <td className="px-4 py-3 text-sm text-gray-600 dark:text-gray-400">
        {resource.uploader.name ?? 'Staff'}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onOpen}
            disabled={opening}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-wait disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {opening ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
            Open
          </button>
          <a
            href={resource.fileUrl}
            download
            onClick={onDownload}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-green-500 to-emerald-500 px-3 py-2 text-xs font-semibold text-white shadow-sm transition-all hover:shadow-md"
          >
            <Download className="w-3.5 h-3.5" />
            Download
          </a>
        </div>
      </td>
    </tr>
  );
}

function ResourceBrowserView({
  node,
  currentPath,
  onChangePath,
  onOpenResource,
  onDownloadResource,
  openingId,
  total,
  loadLimit,
}: {
  node: ResourceBrowserNode;
  currentPath: string;
  onChangePath: (path: string) => void;
  onOpenResource: (resource: SchoolResource) => void;
  onDownloadResource: (resource: SchoolResource) => void;
  openingId: string | null;
  total: number;
  loadLimit: number;
}) {
  const segments = splitBrowsePath(currentPath);
  const folders = node.folders;
  const files = node.files;
  const currentLabel = segments.length > 0 ? segments[segments.length - 1] : 'All resources';

  const goUp = () => {
    if (segments.length === 0) return;
    onChangePath(segments.slice(0, -1).join('/'));
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <div className="flex flex-col gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
            <button
              type="button"
              onClick={() => onChangePath('')}
              className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 font-medium ${
                currentPath === ''
                  ? 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300'
                  : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
              }`}
              title="All resources"
            >
              <Home className="h-4 w-4" />
              <span>All resources</span>
            </button>
            {segments.map((segment, index) => {
              const path = segments.slice(0, index + 1).join('/');
              const active = path === currentPath;
              return (
                <span key={path} className="inline-flex min-w-0 items-center gap-1">
                  <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-gray-300" />
                  <button
                    type="button"
                    onClick={() => onChangePath(path)}
                    className={`max-w-[14rem] truncate rounded-lg px-2 py-1 font-medium ${
                      active
                        ? 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300'
                        : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700'
                    }`}
                    title={path}
                  >
                    {segment}
                  </button>
                </span>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {node.totalFiles.toLocaleString()} file{node.totalFiles === 1 ? '' : 's'} in {currentLabel}
            {total > loadLimit ? ` • showing first ${loadLimit.toLocaleString()} filtered results` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={goUp}
          disabled={segments.length === 0}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <ChevronLeft className="h-4 w-4" />
          Up
        </button>
      </div>

      <div className="grid min-h-[32rem] lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="border-b border-gray-200 bg-gray-50/70 dark:border-gray-700 dark:bg-gray-900/30 lg:border-b-0 lg:border-r">
          <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Folders</p>
          </div>
          <div className="max-h-[32rem] overflow-y-auto p-2">
            {folders.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-gray-400">
                No subfolders here.
              </div>
            ) : (
              <div className="space-y-1">
                {folders.map((folder) => (
                  <button
                    key={folder.path}
                    type="button"
                    onClick={() => onChangePath(folder.path)}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-gray-700 transition-colors hover:bg-white hover:shadow-sm dark:text-gray-300 dark:hover:bg-gray-800"
                    title={folder.path}
                  >
                    <Folder className="h-5 w-5 flex-shrink-0 text-amber-500" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{folder.name}</span>
                      <span className="block text-xs text-gray-400">
                        {folder.totalFiles.toLocaleString()} file{folder.totalFiles === 1 ? '' : 's'}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-gray-300" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        <section className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
            <div className="flex items-center gap-2 text-sm font-semibold text-gray-800 dark:text-gray-200">
              <FolderOpen className="h-4 w-4 text-amber-500" />
              <span>{currentLabel}</span>
            </div>
            <p className="text-xs text-gray-500">
              {folders.length.toLocaleString()} folder{folders.length === 1 ? '' : 's'} • {files.length.toLocaleString()} direct file{files.length === 1 ? '' : 's'}
            </p>
          </div>

          {folders.length > 0 && (
            <div className="grid gap-2 border-b border-gray-200 p-4 dark:border-gray-700 sm:grid-cols-2 xl:grid-cols-3">
              {folders.map((folder) => {
                const active = folder.path === currentPath;
                return (
                  <button
                    key={folder.path}
                    type="button"
                    onClick={() => onChangePath(folder.path)}
                    className={`flex items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors ${
                      active
                        ? 'border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/30'
                        : 'border-gray-200 bg-white hover:border-green-300 hover:bg-green-50/40 dark:border-gray-700 dark:bg-gray-900/40 dark:hover:border-green-800 dark:hover:bg-green-950/20'
                    }`}
                    title={folder.path}
                  >
                    <Folder className="h-5 w-5 flex-shrink-0 text-amber-500" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{folder.name}</span>
                      <span className="block text-xs text-gray-400">
                        {folder.totalFiles.toLocaleString()} file{folder.totalFiles === 1 ? '' : 's'}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {files.length === 0 ? (
            <div className="flex min-h-[22rem] flex-col items-center justify-center px-4 text-center text-gray-400">
              <FolderOpen className="mb-3 h-10 w-10" />
              <p className="text-sm font-medium">No files directly in this folder</p>
              <p className="mt-1 text-xs">Open a subfolder from the left panel.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[900px] w-full border-collapse">
                <thead className="bg-gray-50/80 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:bg-gray-900/60 dark:text-gray-400">
                  <tr>
                    <th className="px-4 py-3">File</th>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3">Subject</th>
                    <th className="px-4 py-3">Category</th>
                    <th className="px-4 py-3">Size</th>
                    <th className="px-4 py-3">Updated</th>
                    <th className="px-4 py-3">Opens</th>
                    <th className="px-4 py-3">Uploader</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {files.map((resource) => (
                    <ResourceRow
                      key={resource.id}
                      resource={resource}
                      onOpen={() => onOpenResource(resource)}
                      onDownload={() => onDownloadResource(resource)}
                      opening={openingId === resource.id}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

type FolderFileItem = {
  file: File;
  relativePath: string;
  status: 'pending' | 'uploading' | 'publishing' | 'done' | 'error';
  error?: string;
};

// Extensions allowed for school resources — kept in sync with /api/upload.
const ALLOWED_EXTS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md',
  '.jpg', '.jpeg', '.png', '.webp', '.gif',
]);

function isHiddenSegment(seg: string): boolean {
  return seg.startsWith('.') || seg === '__MACOSX';
}

function UploadResourceDialog({ onClose, onUploaded }: { onClose: () => void; onUploaded: () => void }) {
  // 'single' = one file (legacy flow), 'folder' = pick a whole directory.
  const [mode, setMode] = useState<'single' | 'folder'>('single');

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
  const folderDoneCount = folderItems.filter((i) => i.status === 'done').length;
  const folderErrorCount = folderItems.filter((i) => i.status === 'error').length;

  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // ---------- single-file flow ----------
  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) {
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
      const res = await fetch('/api/school-resources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to publish');
      onUploaded();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to publish');
      setSubmitting(false);
    }
  };

  // ---------- folder flow ----------
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
      if (segments.some(isHiddenSegment)) { skipped++; continue; }
      if (!ALLOWED_EXTS.has(ext)) { skipped++; continue; }
      if (f.size > 25 * 1024 * 1024) { tooBig++; continue; }
      accepted.push({ file: f, relativePath: rel, status: 'pending' });
    }
    if (accepted.length === 0) {
      setError(
        `No uploadable files in that folder.` +
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
  const processOne = async (item: FolderFileItem, idx: number, subject?: string, category?: string): Promise<boolean> => {
    try {
      updateItem(idx, { status: 'uploading', error: undefined });
      const fd = new FormData();
      fd.append('file', item.file);
      const upRes = await fetch('/api/upload', { method: 'POST', body: fd });
      const upData = await upRes.json();
      if (!upRes.ok || !upData.fileUrl) throw new Error(upData.error || 'Upload failed');

      updateItem(idx, { status: 'publishing' });
      // Use the folder's relative path (minus the top-level folder name)
      // so teachers can reconstruct the structure later.
      const parts = item.relativePath.split('/').filter(Boolean);
      const prettyPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
      const pubRes = await fetch('/api/school-resources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: item.file.name.replace(/\.[^.]+$/, ''),
          description: prettyPath ? `${FOLDER_UPLOAD_PREFIX}${prettyPath}` : '',
          subject,
          category,
          fileUrl: upData.fileUrl,
          fileName: upData.fileName,
          fileSize: upData.fileSize,
          mimeType: upData.mimeType,
        }),
      });
      const pubData = await pubRes.json();
      if (!pubRes.ok) throw new Error(pubData.error || 'Failed to publish');
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
    const subject = folderSubject.trim() || undefined;
    const category = folderCategory.trim() || undefined;
    // Run uploads with a small concurrency cap to be gentle on the server.
    const CONCURRENCY = 3;
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const runNext = async (): Promise<void> => {
      while (cursor < folderItems.length) {
        const idx = cursor++;
        await processOne(folderItems[idx], idx, subject, category);
      }
    };
    for (let i = 0; i < Math.min(CONCURRENCY, folderItems.length); i++) workers.push(runNext());
    await Promise.all(workers);
    setFolderBusy(false);
  };

  const handleRemoveFolder = () => {
    setFolderItems([]);
    setError(null);
  };

  const handleFolderDone = () => {
    onUploaded();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <Upload className="w-5 h-5 text-green-600" /> Upload School Resource
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {mode === 'single' ? 'Share a file with the whole school.' : 'Upload a whole folder — each file becomes its own resource.'}
            </p>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode toggle */}
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {mode === 'single' ? (
            <>
              {/* File picker */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">File</label>
                {!fileMeta ? (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="w-full px-4 py-6 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-500 hover:border-green-400 hover:bg-green-50/40 dark:hover:bg-green-900/10 transition-colors disabled:opacity-50"
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
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,image/*"
                  onChange={handleFilePick}
                  className="hidden"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Y10 Physics S1 Revision Worksheet"
                  className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none"
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
                    className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Category (optional)</label>
                  <input
                    type="text"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="e.g. Worksheet, Slides, Exam, or Handout"
                    className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none"
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
                  className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none resize-y"
                />
              </div>
            </>
          ) : (
            <>
              {/* Folder picker */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Folder</label>
                {folderItems.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => folderInputRef.current?.click()}
                    className="w-full px-4 py-8 border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-500 hover:border-green-400 hover:bg-green-50/40 dark:hover:bg-green-900/10 transition-colors"
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
                        onClick={handleRemoveFolder}
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

              {/* Shared subject/category for the whole folder */}
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
                      className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none disabled:opacity-60"
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
                      className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none disabled:opacity-60"
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
          {error && <ErrorBanner message={error} />}
        </div>

        {/* Footer */}
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
              onClick={handleSubmit}
              disabled={submitting || !title.trim() || !fileMeta}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-500 rounded-xl shadow hover:shadow-md transition-all disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {submitting ? 'Publishing…' : 'Publish Resource'}
            </button>
          ) : folderDoneCount > 0 && !folderBusy ? (
            <button
              onClick={handleFolderDone}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-500 rounded-xl shadow hover:shadow-md transition-all"
            >
              <CheckCircle2 className="w-4 h-4" /> Done
            </button>
          ) : (
            <button
              onClick={handleFolderSubmit}
              disabled={folderBusy || folderItems.length === 0}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-500 rounded-xl shadow hover:shadow-md transition-all disabled:opacity-60 disabled:cursor-not-allowed"
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

// ----------------------------- Note reader -----------------------------
function NoteReader({ note, onClose }: { note: NoteDetail; onClose: () => void }) {
  const authorName = note.author.name ?? 'Anonymous';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {note.courseCode && (
                <span className="text-xs font-semibold px-2 py-0.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 rounded-md">
                  {note.courseCode}
                </span>
              )}
              <span className="text-xs text-gray-500">by {authorName}</span>
              <span className="text-xs text-gray-400">• {fmtDate(note.createdAt)}</span>
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mt-1">{note.title}</h2>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {note.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {note.tags.map((t) => (
                <span key={t} className="text-xs px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-md">
                  #{t}
                </span>
              ))}
            </div>
          )}
          <div className="prose prose-sm max-w-none text-gray-800 dark:text-gray-200">
            <FormattedMessage content={note.content} />
          </div>

          {/* Attachments */}
          {note.attachments && note.attachments.length > 0 && (
            <div className="mt-6 pt-5 border-t border-gray-200 dark:border-gray-700">
              <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-3 flex items-center gap-1.5">
                <Paperclip className="w-4 h-4 text-gray-500" />
                Attachments ({note.attachments.length})
              </h3>
              <ul className="space-y-2">
                {note.attachments.map((a) => (
                  <li key={a.url}>
                    <a
                      href={a.url}
                      download={a.name}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-3 px-3 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl hover:border-green-300 hover:bg-green-50/40 dark:hover:bg-green-900/10 transition-colors group"
                    >
                      <div className="w-9 h-9 rounded-lg bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 flex items-center justify-center flex-shrink-0">
                        <FileText className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{a.name}</p>
                        <p className="text-xs text-gray-400">
                          {(a.size / 1024).toFixed(0)} KB
                          {a.type && a.type !== 'application/octet-stream' ? ` · ${a.type.split('/').pop()}` : ''}
                        </p>
                      </div>
                      <Download className="w-4 h-4 text-gray-400 group-hover:text-green-600 flex-shrink-0" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Comments */}
          <div className="mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-3">
              Comments ({note.comments.length})
            </h3>
            {note.comments.length === 0 ? (
              <p className="text-sm text-gray-400">No comments yet.</p>
            ) : (
              <div className="space-y-3">
                {note.comments.map((c) => (
                  <div key={c.id} className="flex gap-3">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-green-500 to-emerald-500 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                      {c.user.name?.[0]?.toUpperCase() ?? 'A'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                        {c.user.name ?? 'Anonymous'} <span className="text-gray-400 font-normal">· {fmtDate(c.createdAt)}</span>
                      </p>
                      <p className="text-sm text-gray-700 dark:text-gray-300 mt-0.5">{c.content}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between text-xs text-gray-400">
          <span className="inline-flex items-center gap-1"><Eye className="w-3.5 h-3.5" /> {note.views} views</span>
          {note.avgRating !== null && (
            <span className="inline-flex items-center gap-1">
              <Star className="w-3.5 h-3.5 text-amber-500 fill-amber-500" /> {note.avgRating.toFixed(1)} ({note.ratingCount})
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ----------------------------- Publish dialog -----------------------------
function PublishNoteDialog({ onClose, onPublished }: { onClose: () => void; onPublished: () => void }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [subject, setSubject] = useState('');
  const [courseCode, setCourseCode] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFilePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;

    setUploadingFiles(true);
    setError(null);
    try {
      const uploaded: Attachment[] = [];
      for (const file of files) {
        if (file.size > 25 * 1024 * 1024) {
          throw new Error(`${file.name} is too large (max 25 MB).`);
        }
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok || !data.fileUrl) throw new Error(data.error || `Failed to upload ${file.name}`);
        // The upload route puts images under /uploads/images and docs under
        // /uploads/files. Only docs belong in the attachment list — images
        // are embedded inline via the rich-text editor.
        if (data.kind === 'file') {
          uploaded.push({ url: data.fileUrl, name: data.fileName, type: data.mimeType, size: data.fileSize });
        } else {
          setError((prev) => (prev ? prev + '\n' : '') + `${file.name} is an image — use the image button in the editor to embed it inline.`);
        }
      }
      if (uploaded.length) setAttachments((prev) => [...prev, ...uploaded]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload file(s)');
    } finally {
      setUploadingFiles(false);
    }
  };

  const handlePublish = async () => {
    if (!title.trim() || !content.trim()) {
      setError('Title and content are required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    const tags = tagsRaw.split(',').map((t) => t.trim()).filter(Boolean);
    try {
      const res = await fetch('/api/shared-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          content,
          subject: subject.trim() || undefined,
          courseCode: courseCode.trim() || undefined,
          tags,
          attachments,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to publish');
      onPublished();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to publish');
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-green-600" /> Share a Note
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">Publish to the community library (public).</p>
          </div>
          <button onClick={onClose} className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. A-Level Mechanics — Summary Sheet"
              className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Subject (optional)</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g. Physics, Math, Economics"
                list="shared-note-subjects"
                className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none"
              />
              <datalist id="shared-note-subjects">
                <option value="Physics" />
                <option value="Chemistry" />
                <option value="Biology" />
                <option value="Mathematics" />
                <option value="Economics" />
                <option value="Computer Science" />
                <option value="English" />
                <option value="Chinese" />
                <option value="History" />
                <option value="Geography" />
              </datalist>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Course code (optional)</label>
              <input
                type="text"
                value={courseCode}
                onChange={(e) => setCourseCode(e.target.value)}
                placeholder="e.g. PHYS-101"
                className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Tags (comma-separated)</label>
            <input
              type="text"
              value={tagsRaw}
              onChange={(e) => setTagsRaw(e.target.value)}
              placeholder="e.g. mechanics, revision, formulas"
              className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Content</label>
            <RichTextEditor content={content} onChange={setContent} />
            <p className="text-xs text-gray-400 mt-1">
              Use the image button in the toolbar to upload images inline. Markdown and LaTeX are supported.
            </p>
          </div>

          {/* File attachments */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Attachments (PDF, Word, Excel, PowerPoint, text)
            </label>
            <div className="flex flex-wrap gap-2 items-center">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingFiles}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-xl transition-colors disabled:opacity-50"
              >
                {uploadingFiles ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {uploadingFiles ? 'Uploading…' : 'Add files'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/markdown"
                onChange={handleFilePick}
                className="hidden"
              />
              {attachments.length === 0 && !uploadingFiles && (
                <span className="text-xs text-gray-400">No files attached.</span>
              )}
            </div>
            {attachments.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {attachments.map((a, i) => (
                  <li
                    key={a.url}
                    className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-sm"
                  >
                    <Paperclip className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    <span className="flex-1 truncate text-gray-700 dark:text-gray-300">{a.name}</span>
                    <span className="text-xs text-gray-400 flex-shrink-0">{(a.size / 1024).toFixed(0)} KB</span>
                    <button
                      type="button"
                      onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                      className="p-1 text-gray-400 hover:text-red-600 rounded transition-colors"
                      title="Remove attachment"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {error && <ErrorBanner message={error} />}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-xl transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handlePublish}
            disabled={submitting || !title.trim() || !content.trim()}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-500 rounded-xl shadow hover:shadow-md transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            {submitting ? 'Publishing…' : 'Publish Note'}
          </button>
        </div>
      </div>
    </div>
  );
}
