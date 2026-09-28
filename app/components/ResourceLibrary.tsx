'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Users, Search, Loader2, AlertCircle, BookOpen, FileText,
  Download, Eye, Plus, X, Clock,
  Library, Heart, MessageCircle, ArrowUpDown, ChevronLeft, ChevronRight,
  Paperclip, Upload, Trash2, FolderUp, CheckCircle2, XCircle, File as FileIcon,
  Folder, FolderOpen, Home,
} from 'lucide-react';
import { sanitizeHtml } from '@/lib/sanitize-html';
import ResourceFolderPicker from './ResourceFolderPicker';
import { useScreenContext } from './ScreenContext';
import {
  ALLOWED_RESOURCE_EXTS as ALLOWED_EXTS,
  RESOURCE_UPLOAD_MAX_BYTES,
  isHiddenUploadSegment as isHiddenSegment,
} from '@/lib/upload-constants';
import { Contributor } from './ui';
import type { ContributorUser } from './ui';

/** Which half of Materials is showing. Owned by `MaterialsHub`, which renders
 *  the tab strip in its header so the screen has one rule and not two. */
export type MaterialsTab = 'notes' | 'school';

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
/**
 * The tab strip, rendered by `MaterialsHub` inside its header block.
 *
 * It lives up there rather than at the top of the library because it carries
 * no border of its own: the header's rule is the one the active underline sits
 * on, via `-mb-px` below. Kept here, beside the views it switches between, so
 * adding a third half means touching one file.
 */
export function MaterialsTabs({
  tab,
  onChange,
}: {
  tab: MaterialsTab;
  onChange: (tab: MaterialsTab) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <TabButton active={tab === 'notes'} onClick={() => onChange('notes')} icon={<Users className="w-4 h-4" />}>
        Shared Notes
      </TabButton>
      <TabButton active={tab === 'school'} onClick={() => onChange('school')} icon={<Library className="w-4 h-4" />}>
        School Resources
      </TabButton>
    </div>
  );
}

/**
 * Neither the title, the supporting line, nor the tabs are here: MaterialsHub
 * carries all three on one header, for both of this screen's halves.
 *
 * There was a My courses / All subjects control here as well. It did the same
 * job as the subject select inside the School Resources tab, one level up and
 * with a different vocabulary, and defaulted to hiding everything outside the
 * student's own courses -- in a library the whole year group uploads to, where
 * a resource is just as likely to be useful outside your subjects. Narrowing is
 * still there, in the select that sits with the other filters.
 */
export default function ResourceLibrary({ tab }: { tab: MaterialsTab }) {
  return (
    <div className="h-full overflow-y-auto px-6 pb-6 pt-6 md:px-8 md:pb-8">
      <div className="max-w-6xl mx-auto">
        {tab === 'notes' ? <SharedNotesTab /> : <SchoolResourcesTab />}
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
          ? 'border-accent text-accent-text'
          : 'border-transparent text-muted hover:text-secondary'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="bg-danger-subtle border border-danger-border rounded-lg p-5 flex items-start gap-3">
      <AlertCircle className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="text-sm font-semibold text-danger">{message}</p>
        {onRetry && (
          <button onClick={onRetry} className="mt-2 text-sm text-danger underline">Try again</button>
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
function SharedNotesTab() {
  // Students now publish directly to review.ykpao.com; the in-app community
  // notes library (publish/browse notes shared by other students) has been
  // retired in favor of that single external source.
  return <ExternalNotesView />;
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
      <div className="flex items-center justify-center py-16 text-muted">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Fetching posts from YKPao Review…
      </div>
    );
  }
  if (error) return <ErrorBanner message={error} onRetry={load} />;

  return (
    <>
      {/* Search */}
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. exam tips, revision, or Biology"
          className="w-full pl-10 pr-4 py-2.5 bg-surface border border-strong rounded-lg text-sm text-primary focus:ring-2 focus:ring-ring/25 focus:border-transparent outline-none"
        />
      </div>

      <div className="flex items-center gap-2 text-xs text-muted">
        <BookOpen className="w-3.5 h-3.5" />
        <span>Sourced from <a href="https://review.ykpao.com" target="_blank" rel="noopener noreferrer" className="text-accent-text hover:underline">review.ykpao.com</a></span>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-surface rounded-lg border border-dashed border-strong p-12 text-center">
          <BookOpen className="w-12 h-12 mx-auto text-muted mb-3" />
          <h3 className="text-lg font-bold text-primary">No posts found</h3>
          <p className="text-sm text-muted mt-1">Try a different search.</p>
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
      className="text-left bg-surface rounded-lg border border-line hover:border-accent-border transition-all p-5 flex flex-col"
    >
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
          {note.author[0]?.toUpperCase() ?? 'K'}
        </div>
        <span className="text-xs text-muted truncate">{note.author}</span>
        <span className="text-xs text-muted ml-auto">
          {new Date(note.publishedAt ?? note.pubDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
        </span>
      </div>

      <h3 className="font-bold text-primary mt-3 line-clamp-2">{note.title}</h3>
      <p className="text-sm text-muted mt-1 line-clamp-3 flex-1">{note.excerpt}</p>

      {note.categories.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {note.categories.slice(0, 3).map((c, i) => (
            <span key={i} className="text-xs px-2 py-0.5 bg-surface-raised text-secondary rounded-md">
              {c}
            </span>
          ))}
        </div>
      )}

      {showStats && (
        <div className="flex items-center gap-3 mt-3 pt-3 border-t border-subtle text-xs text-muted">
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
        className="bg-surface rounded-lg shadow-overlay w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-line flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-muted">by {note.author}</span>
              <span className="text-xs text-muted">· {new Date(note.pubDate).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</span>
            </div>
            <h2 className="text-xl font-bold text-primary mt-1">{note.title}</h2>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <a
              href={note.link}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 text-muted hover:text-accent-text hover:bg-surface-hover rounded-md transition-colors"
              title="Open original" aria-label="Open original"
            >
              <Eye className="w-5 h-5" />
            </a>
            <button onClick={onClose} className="p-2 text-muted hover:text-secondary hover:bg-surface-hover rounded-md transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Post stats bar */}
          <div className="flex flex-wrap items-center gap-4 mb-4 pb-3 border-b border-subtle text-xs text-muted">
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
                <span key={i} className="text-xs px-2 py-0.5 bg-surface-raised text-secondary rounded-md">
                  {c}
                </span>
              ))}
            </div>
          )}
          {note.content ? (
            <div
              className="prose prose-sm max-w-none text-primary [&_p]:my-2 [&_ul]:my-2 [&_li]:ml-4 [&_li]:list-disc [&_h1]:text-lg [&_h1]:font-bold [&_h2]:text-base [&_h2]:font-semibold [&_a]:text-secondary [&_a]:underline hover:[&_a]:text-secondary [&_img]:rounded-md [&_img]:max-w-full"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(note.content) }}
            />
          ) : loadingContent ? (
            <div className="flex items-center justify-center py-12 text-muted">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading content…
            </div>
          ) : (
            <p className="text-sm text-muted italic">No content available. <a href={note.link} target="_blank" rel="noopener noreferrer" className="text-accent-text underline">View original →</a></p>
          )}

          {/* Comment notice */}
          {note.commentCount == null && (
            <div className="mt-6 p-3 bg-surface-raised border border-line rounded-lg text-xs text-muted flex items-center gap-2">
              <MessageCircle className="w-4 h-4 flex-shrink-0" />
              <span>
                Comments are loaded on the original site (require its own login).
                <a href={`${note.link}#comment`} target="_blank" rel="noopener noreferrer" className="ml-1 text-accent-text underline">View comments on YKPao Review →</a>
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
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
  folder: { id: string; name: string } | null;
};

type ResourceSort = 'createdAt' | 'updatedAt' | 'title' | 'fileName' | 'downloads' | 'fileSize';
type ResourceSortOrder = 'asc' | 'desc';

/** A resource's immediate subfolder, as returned for the current browse location. */
type ResourceFolderEntry = { id: string; name: string; fileCount: number; createdBy?: ContributorUser | null };
/** One link in the breadcrumb from the library root down to the current folder. */
type ResourceBreadcrumbEntry = { id: string; name: string };

type ResourcePageResponse = {
  resources: SchoolResource[];
  total: number;
  page: number;
  totalPages: number;
  subjects?: string[];
  categories?: string[];
  folders?: ResourceFolderEntry[];
  breadcrumb?: ResourceBreadcrumbEntry[];
};

type ResourceViewMode = 'list' | 'browser';
const BROWSER_RESOURCE_LIMIT = 100;

function formatResourceDescription(resource: SchoolResource): string {
  const description = resource.description?.trim();
  return description || '—';
}

function SchoolResourcesTab() {
  const [resources, setResources] = useState<SchoolResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ResourceViewMode>('browser');
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [folderEntries, setFolderEntries] = useState<ResourceFolderEntry[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<ResourceBreadcrumbEntry[]>([]);
  // Where in the folder tree the student is, so "is there anything here on
  // electrolysis?" can be answered about the folder they are actually in.
  const { updateData } = useScreenContext();
  useEffect(() => {
    updateData({
      resourceFolderPath: breadcrumb.length
        ? ['Root', ...breadcrumb.map((entry) => entry.name)].join(' / ')
        : undefined,
    });
  }, [breadcrumb, updateData]);
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
      const pageForRequest = page;
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (subjectFilter) params.set('subject', subjectFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      params.set('sort', sortBy);
      params.set('order', sortOrder);
      params.set('page', String(pageForRequest));
      params.set('limit', String(limit));
      // Sent explicitly, and always 'all'. resolveCourseScope treats a missing
      // scope as 'enrolled', so dropping the parameter along with the control
      // would have quietly hidden every resource outside the student's own
      // courses with nothing on screen to say so.
      params.set('scope', 'all');
      // An empty (root) folderId is still sent explicitly -- its mere
      // presence switches the API into folder-scoped mode.
      if (isBrowserRequest) params.set('folderId', currentFolderId ?? '');
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
      setFolderEntries(data.folders ?? []);
      setBreadcrumb(data.breadcrumb ?? []);
      if (page > nextTotalPages) setPage(nextTotalPages);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load resources');
    } finally {
      setLoading(false);
    }
  }, [categoryFilter, currentFolderId, page, pageSize, query, sortBy, sortOrder, subjectFilter, viewMode]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void load();
    }, query.trim() ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query, refreshTick, viewMode]);

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
    setCurrentFolderId(null);
  };

  const changeFolder = (id: string | null) => {
    setCurrentFolderId(id);
    setPage(1);
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
      {/* Count + view mode + upload.

          No "School Resources" heading here: the tab the student just clicked
          in MaterialsHub's header says that, immediately above this, under a
          "Materials" title that says it again. The count is the only part of
          the old heading block that the tab label did not already carry, so it
          stands on its own. */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <p className="text-sm text-secondary">
          {isBrowserView
            ? `${total.toLocaleString()} direct file${total === 1 ? '' : 's'} in ${breadcrumb.length ? breadcrumb[breadcrumb.length - 1].name : 'Root'}`
            : `${total.toLocaleString()} resource${total === 1 ? '' : 's'} across all folders`}
        </p>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-line bg-surface p-1">
            <button
              type="button"
              onClick={() => switchViewMode('list')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold transition-colors ${
                !isBrowserView
                  ? 'bg-accent text-white'
                  : 'text-secondary hover:bg-surface-hover'
              }`}
              title="List view" aria-label="List view"
            >
              <FileText className="w-4 h-4" />
              List
            </button>
            <button
              type="button"
              onClick={() => switchViewMode('browser')}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold transition-colors ${
                isBrowserView
                  ? 'bg-accent text-white'
                  : 'text-secondary hover:bg-surface-hover'
              }`}
              title="Folder browser" aria-label="Folder browser"
            >
              <FolderOpen className="w-4 h-4" />
              Browser
            </button>
          </div>
          <button
            onClick={() => setShowUpload(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all"
          >
            <Upload className="w-4 h-4" /> Upload Resource
          </button>
        </div>
      </div>

      {/* Search + filters */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.5fr)_minmax(180px,0.8fr)_minmax(180px,0.8fr)_minmax(150px,0.6fr)_minmax(120px,0.5fr)]">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            placeholder="e.g. worksheet, 2024, Biology, or Ms Lee"
            className="w-full pl-10 pr-10 py-2.5 bg-surface border border-strong rounded-lg text-sm text-primary focus:ring-2 focus:ring-ring/25 focus:border-transparent outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(''); setPage(1); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted hover:text-secondary hover:bg-surface-hover"
              aria-label="Clear search"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <select
          value={subjectFilter}
          onChange={(e) => { setSubjectFilter(e.target.value); setPage(1); }}
          className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm text-primary outline-none focus:ring-2 focus:ring-ring/25"
        >
          <option value="">All subjects</option>
          {subjectOptions.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
        </select>
        <select
          value={categoryFilter}
          onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }}
          className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm text-primary outline-none focus:ring-2 focus:ring-ring/25"
        >
          <option value="">All categories</option>
          {categoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}
        </select>
        <select
          value={sortBy}
          onChange={(e) => { setSortBy(e.target.value as ResourceSort); setPage(1); }}
          className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm text-primary outline-none focus:ring-2 focus:ring-ring/25"
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
            className="inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-lg border border-strong bg-surface px-3 py-2.5 text-sm font-medium text-secondary hover:bg-surface-hover"
            title="Toggle sort order" aria-label="Toggle sort order"
          >
            <ArrowUpDown className="w-4 h-4" />
            {sortOrder === 'desc' ? 'Descending' : 'Ascending'}
          </button>
          <select
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
            className="w-24 px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm text-primary outline-none focus:ring-2 focus:ring-ring/25"
            title="Rows per page" aria-label="Rows per page"
          >
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
          </select>
        </div>
      </div>

      {/* List / Browser */}
      {loading && resources.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-muted">
          <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading resources…
        </div>
      ) : error ? (
        <ErrorBanner message={error} onRetry={load} />
      ) : resources.length === 0 && !isBrowserView ? (
        <div className="bg-surface rounded-lg border border-dashed border-strong p-12 text-center">
          <Library className="w-12 h-12 mx-auto text-muted mb-3" />
          <h3 className="text-lg font-bold text-primary">No resources yet</h3>
          <p className="text-sm text-muted mt-1">
            {query || subjectFilter || categoryFilter ? 'Try a different search or filter.' : 'Upload the first school resource.'}
          </p>
          {(query || subjectFilter || categoryFilter) && (
            <button
              onClick={clearFilters}
              className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-strong bg-surface px-4 py-2 text-sm font-medium text-secondary hover:bg-surface-hover"
            >
              <X className="w-4 h-4" /> Clear filters
            </button>
          )}
        </div>
      ) : isBrowserView ? (
        <ResourceBrowserView
          folders={folderEntries}
          files={resources}
          breadcrumb={breadcrumb}
          onChangeFolder={changeFolder}
          onOpenResource={openResource}
          onDownloadResource={trackAccess}
          openingId={openingId}
          total={total}
          loadLimit={BROWSER_RESOURCE_LIMIT}
          page={page}
          totalPages={totalPages}
          onPageChange={setPage}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div className="flex items-center gap-3 text-xs text-muted">
              <span>{pageStart.toLocaleString()}-{pageEnd.toLocaleString()} of {total.toLocaleString()}</span>
              {loading && <span className="inline-flex items-center gap-1 text-accent-text"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Refreshing</span>}
            </div>
            <button
              onClick={clearFilters}
              className="inline-flex items-center gap-1.5 rounded-md border border-strong bg-surface px-3 py-2 text-xs font-medium text-secondary hover:bg-surface-hover"
            >
              <X className="w-3.5 h-3.5" /> Clear filters
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1120px] w-full border-collapse">
              <thead className="bg-surface-raised/80 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
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
              <tbody className="divide-y divide-subtle">
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

          <div className="flex flex-col gap-3 border-t border-line px-4 py-3 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
            <p>
              Showing {pageStart.toLocaleString()}-{pageEnd.toLocaleString()} of {total.toLocaleString()}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page <= 1}
                className="inline-flex items-center gap-1.5 rounded-md border border-strong bg-surface px-3 py-2 text-sm font-medium text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ChevronLeft className="w-4 h-4" /> Prev
              </button>
              <span className="text-xs uppercase tracking-wide text-muted">
                Page {page.toLocaleString()} of {totalPages.toLocaleString()}
              </span>
              <button
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={page >= totalPages}
                className="inline-flex items-center gap-1.5 rounded-md border border-strong bg-surface px-3 py-2 text-sm font-medium text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {showUpload && (
        <UploadResourceDialog
          initialFolderId={isBrowserView ? currentFolderId : null}
          initialBreadcrumb={isBrowserView ? breadcrumb : []}
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
    <tr className="align-top transition-colors hover:bg-surface-raised/70">
      <td className="px-4 py-3">
        <button type="button" onClick={onOpen} className="flex items-start gap-3 text-left">
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-accent text-[10px] font-bold text-white">
            {ext}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-primary">{resource.title}</span>
            <span className="block truncate text-xs text-muted">{resource.fileName}</span>
          </span>
        </button>
      </td>
      <td className="px-4 py-3 text-sm text-secondary">
        <p className="max-w-[280px] truncate font-medium">{formatResourceDescription(resource)}</p>
      </td>
      <td className="px-4 py-3 text-sm text-secondary">
        {resource.subject ?? '—'}
      </td>
      <td className="px-4 py-3 text-sm text-secondary">
        {resource.category ?? '—'}
      </td>
      <td className="px-4 py-3 text-sm text-secondary">
        {fmtSize(resource.fileSize)}
      </td>
      <td className="px-4 py-3 text-sm text-secondary">
        {fmtDate(resource.updatedAt)}
      </td>
      <td className="px-4 py-3 text-sm text-secondary">
        {resource.downloads.toLocaleString()}
      </td>
      <td className="px-4 py-3 text-sm text-secondary">
        <Contributor user={resource.uploader} />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onOpen}
            disabled={opening}
            className="inline-flex items-center gap-1.5 rounded-md border border-strong bg-surface px-3 py-2 text-xs font-medium text-secondary hover:bg-surface-hover disabled:cursor-wait disabled:opacity-60"
          >
            {opening ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
            Open
          </button>
          <a
            href={resource.fileUrl}
            download
            onClick={onDownload}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white transition-all"
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
  folders,
  files,
  breadcrumb,
  onChangeFolder,
  onOpenResource,
  onDownloadResource,
  openingId,
  total,
  loadLimit,
  page,
  totalPages,
  onPageChange,
}: {
  folders: ResourceFolderEntry[];
  files: SchoolResource[];
  breadcrumb: ResourceBreadcrumbEntry[];
  onChangeFolder: (id: string | null) => void;
  onOpenResource: (resource: SchoolResource) => void;
  onDownloadResource: (resource: SchoolResource) => void;
  openingId: string | null;
  total: number;
  loadLimit: number;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [createError, setCreateError] = useState('');
  const currentFolderId = breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1].id : null;
  const currentLabel = breadcrumb.length > 0 ? breadcrumb[breadcrumb.length - 1].name : 'Root';
  const directFileCount = total;

  const goUp = () => {
    if (breadcrumb.length === 0) return;
    onChangeFolder(breadcrumb.length > 1 ? breadcrumb[breadcrumb.length - 2].id : null);
  };

  const createFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setCreateError('');
    try {
      const response = await fetch('/api/school-resource-folders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId: currentFolderId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not create folder');
      setCreating(false);
      setNewFolderName('');
      onChangeFolder(body.folder.id);
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : 'Could not create folder');
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex flex-col gap-3 border-b border-line px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
            <button
              type="button"
              onClick={() => onChangeFolder(null)}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium ${
                currentFolderId === null
                  ? 'bg-accent-subtle text-accent-text'
                  : 'text-secondary hover:bg-surface-hover'
              }`}
              title="Root" aria-label="Root"
            >
              <Home className="h-4 w-4" />
              <span>Root</span>
            </button>
            {breadcrumb.map((crumb, index) => {
              const active = index === breadcrumb.length - 1;
              return (
                <span key={crumb.id} className="inline-flex min-w-0 items-center gap-1">
                  <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted" />
                  <button
                    type="button"
                    onClick={() => onChangeFolder(crumb.id)}
                    className={`max-w-[14rem] truncate rounded-md px-2 py-1 font-medium ${
                      active
                        ? 'bg-accent-subtle text-accent-text'
                        : 'text-secondary hover:bg-surface-hover'
                    }`}
                    title={crumb.name} aria-label={crumb.name}
                  >
                    {crumb.name}
                  </button>
                </span>
              );
            })}
          </div>
          <p className="mt-1 text-xs text-muted">
            {directFileCount.toLocaleString()} file{directFileCount === 1 ? '' : 's'} in {currentLabel}
            {total > loadLimit ? ` • page ${page.toLocaleString()} of ${totalPages.toLocaleString()}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
        <button type="button" onClick={() => setCreating((current) => !current)} className="inline-flex items-center gap-1.5 rounded-md border border-strong bg-surface px-3 py-2 text-sm font-medium text-secondary hover:bg-surface-hover"><Plus className="h-4 w-4" /> New folder</button>
        <button
          type="button"
          onClick={goUp}
          disabled={breadcrumb.length === 0}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-strong bg-surface px-3 py-2 text-sm font-medium text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ChevronLeft className="h-4 w-4" />
          Up
        </button>
        </div>
      </div>
      {creating && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
          <input value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createFolder(); }} placeholder="Folder name" aria-label="Folder name" className="rounded-md border border-strong bg-surface px-3 py-2 text-sm" />
          <button type="button" onClick={() => void createFolder()} disabled={!newFolderName.trim()} className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Create</button>
          {createError && <span className="text-xs text-danger">{createError}</span>}
        </div>
      )}

      <div className="grid min-h-[32rem] lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="border-b border-line bg-surface-raised/70 lg:border-b-0 lg:border-r">
          <div className="border-b border-line px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Folders</p>
          </div>
          <div className="max-h-[32rem] overflow-y-auto p-2">
            {folders.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-muted">
                No subfolders here.
              </div>
            ) : (
              <div className="space-y-1">
                {folders.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => onChangeFolder(folder.id)}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-secondary transition-colors hover:bg-surface"
                    title={folder.name} aria-label={folder.name}
                  >
                    <Folder className="h-5 w-5 flex-shrink-0 text-warning" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{folder.name}</span>
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                        <span className="flex-shrink-0">
                          {folder.fileCount.toLocaleString()} file{folder.fileCount === 1 ? '' : 's'}
                        </span>
                        {folder.createdBy ? (
                          <>
                            <span aria-hidden="true" className="flex-shrink-0">·</span>
                            <Contributor user={folder.createdBy} className="min-w-0" />
                          </>
                        ) : null}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted" />
                  </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        <section className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-primary">
              <FolderOpen className="h-4 w-4 text-warning" />
              <span>{currentLabel}</span>
            </div>
            <p className="text-xs text-muted">
              {folders.length.toLocaleString()} folder{folders.length === 1 ? '' : 's'} • {total.toLocaleString()} direct file{total === 1 ? '' : 's'}
            </p>
          </div>

          {folders.length > 0 && (
            <div className="grid gap-2 border-b border-line p-4 sm:grid-cols-2 xl:grid-cols-3">
              {folders.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  onClick={() => onChangeFolder(folder.id)}
                  className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-3 text-left transition-colors hover:border-accent-border hover:bg-accent-subtle"
                  title={folder.name} aria-label={folder.name}
                >
                  <Folder className="h-5 w-5 flex-shrink-0 text-warning" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-primary">{folder.name}</span>
                    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                      <span className="flex-shrink-0">
                        {folder.fileCount.toLocaleString()} file{folder.fileCount === 1 ? '' : 's'}
                      </span>
                      {folder.createdBy ? (
                        <>
                          <span aria-hidden="true" className="flex-shrink-0">·</span>
                          <Contributor user={folder.createdBy} className="min-w-0" />
                        </>
                      ) : null}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {files.length === 0 ? (
            <div className="flex min-h-[22rem] flex-col items-center justify-center px-4 text-center text-muted">
              <FolderOpen className="mb-3 h-10 w-10" />
              <p className="text-sm font-medium">No files directly in this folder</p>
              <p className="mt-1 text-xs">Open a subfolder from the left panel.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[900px] w-full border-collapse">
                <thead className="bg-surface-raised/80 text-left text-[11px] font-semibold uppercase tracking-wide text-muted">
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
                <tbody className="divide-y divide-subtle">
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
          {totalPages > 1 && (
            <div className="flex items-center justify-end gap-3 border-t border-line px-4 py-3 text-sm">
              <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="rounded-md border border-strong px-3 py-1.5 disabled:opacity-50">Previous</button>
              <span className="text-muted">{page} / {totalPages}</span>
              <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} className="rounded-md border border-strong px-3 py-1.5 disabled:opacity-50">Next</button>
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

function UploadResourceDialog({ onClose, onUploaded, initialFolderId, initialBreadcrumb }: {
  onClose: () => void;
  onUploaded: () => void;
  initialFolderId: string | null;
  initialBreadcrumb: ResourceBreadcrumbEntry[];
}) {
  // 'single' = one file (legacy flow), 'folder' = pick a whole directory.
  const [mode, setMode] = useState<'single' | 'folder'>('single');

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
    if (file.size > RESOURCE_UPLOAD_MAX_BYTES) {
      setError('File too large (max 25 MB).');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (destinationId) fd.append('resourceFolderId', destinationId);
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
          folderId: destinationId,
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
      if (f.size > RESOURCE_UPLOAD_MAX_BYTES) { tooBig++; continue; }
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
      const parts = item.relativePath.split('/').filter(Boolean);
      const folderPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
      if (folderPath) fd.append('resourceFolderPath', folderPath);
      if (destinationId) fd.append('resourceParentFolderId', destinationId);
      if (!folderPath && destinationId) fd.append('resourceFolderId', destinationId);
      const upRes = await fetch('/api/upload', { method: 'POST', body: fd });
      const upData = await upRes.json();
      if (!upRes.ok || !upData.fileUrl) throw new Error(upData.error || 'Upload failed');

      updateItem(idx, { status: 'publishing' });
      // Use the folder's relative path (minus the top-level folder name) so
      // the server can resolve/create the matching SchoolResourceFolder chain.
      const pubRes = await fetch('/api/school-resources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: item.file.name.replace(/\.[^.]+$/, ''),
          folderId: upData.resourceFolderId,
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
        className="bg-surface rounded-lg shadow-overlay w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-line flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-primary flex items-center gap-2">
              <Upload className="w-5 h-5 text-accent-text" /> Upload School Resource
            </h2>
            <p className="text-xs text-muted mt-0.5">
              {mode === 'single' ? 'Share a file with the whole school.' : 'Upload a whole folder — each file becomes its own resource.'}
            </p>
          </div>
          <button onClick={onClose} className="p-2 text-muted hover:text-secondary hover:bg-surface-hover rounded-md transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Mode toggle */}
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-secondary mb-1.5">Upload into folder</label>
            <ResourceFolderPicker value={destinationId} onChange={setDestinationId} initialBreadcrumb={initialBreadcrumb} disabled={uploading || submitting || folderBusy || Boolean(fileMeta) || folderDoneCount > 0} />
          </div>
          {mode === 'single' ? (
            <>
              {/* File picker */}
              <div>
                <label className="block text-sm font-medium text-secondary mb-1.5">File</label>
                {!fileMeta ? (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="w-full px-4 py-6 border-2 border-dashed border-strong rounded-lg text-sm text-muted hover:border-accent hover:bg-accent-subtle transition-colors disabled:opacity-50"
                  >
                    {uploading ? (
                      <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Uploading…</span>
                    ) : (
                      <span className="inline-flex items-center gap-2"><Upload className="w-4 h-4" /> Click to choose a file (PDF, Word, Excel, PowerPoint, images — up to 25 MB)</span>
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
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,image/*"
                  onChange={handleFilePick}
                  className="hidden"
                />
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
              {/* Folder picker */}
              <div>
                <label className="block text-sm font-medium text-secondary mb-1.5">Folder</label>
                {folderItems.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => folderInputRef.current?.click()}
                    className="w-full px-4 py-8 border-2 border-dashed border-strong rounded-lg text-sm text-muted hover:border-accent hover:bg-accent-subtle transition-colors"
                  >
                    <FolderUp className="w-6 h-6 mx-auto mb-2 text-muted" />
                    <span className="inline-flex items-center gap-2">Click to choose a folder — every supported file inside will be uploaded as a separate resource.</span>
                    <p className="text-xs text-muted mt-2">
                      Supports PDF, Word, Excel, PowerPoint, TXT, Markdown, images. Hidden/system files and files over 25 MB are skipped.
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
                        onClick={handleRemoveFolder}
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

              {/* Shared subject/category for the whole folder */}
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
          {error && <ErrorBanner message={error} />}
        </div>

        {/* Footer */}
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
              onClick={handleSubmit}
              disabled={submitting || !title.trim() || !fileMeta}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              {submitting ? 'Publishing…' : 'Publish Resource'}
            </button>
          ) : folderDoneCount > 0 && !folderBusy ? (
            <button
              onClick={handleFolderDone}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all"
            >
              <CheckCircle2 className="w-4 h-4" /> Done
            </button>
          ) : (
            <button
              onClick={handleFolderSubmit}
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
