'use client';

import dynamic from 'next/dynamic';
import Image from 'next/image';
import type { DrawingCanvasHandle } from './DrawingCanvas';
import { useSession } from 'next-auth/react';
import toast from 'react-hot-toast';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  CloudOff,
  Copy,
  Eye,
  FileClock,
  FileText,
  FolderInput,
  FolderPlus,
  History,
  Loader2,
  Menu,
  MessageSquare,
  MoreVertical,
  Notebook as NotebookIcon,
  PanelLeftClose,
  PanelRightClose,
  PenTool,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Share2,
  Sparkles,
  SplitSquareHorizontal,
  Star,
  Tags,
  Trash2,
  UserPlus,
  Users,
  X,
  Zap,
} from 'lucide-react';
import FormattedMessage from './FormattedMessage';
import { useScreenContext } from './ScreenContext';
import { usePageCollaboration } from './usePageCollaboration';
import { useMeasuredCanvasWidth } from './useMeasuredCanvasWidth';
import { useConfirm } from './useConfirm';
import type { RemoteCursor } from './RemoteCursors';

const RichTextEditor = dynamic(() => import('./RichTextEditor'), {
  ssr: false,
  loading: () => (
    <div className="flex h-72 items-center justify-center text-sm text-muted">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading editor
    </div>
  ),
});

const RichContent = dynamic(() => import('./RichContent'), { ssr: false });
const DrawingCanvas = dynamic(() => import('./DrawingCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-80 items-center justify-center text-sm text-muted">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading canvas
    </div>
  ),
});

type AccessRole = 'owner' | 'editor' | 'viewer';
type SaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'conflict' | 'error';
type FilterMode = 'all' | 'favorites' | 'recent' | 'archive';
type SidePanel = 'details' | 'history' | 'comments' | 'share' | null;

type Person = { id: string; name: string | null; email: string; image: string | null };
type Collaborator = { id: string; userId: string; role: 'editor' | 'viewer'; user: Person };

type NotePage = {
  id: string;
  sectionId: string;
  title: string;
  content: string;
  icon: string;
  tags: string[];
  favorite: boolean;
  archived: boolean;
  linkedQuestionIds: number[];
  splitQuestionId: number | null;
  revision: number;
  order: number;
  updatedAt: string;
  accessRole?: AccessRole;
  collaborators?: Collaborator[];
};

type Section = { id: string; name: string; order: number; pages: NotePage[] };
type Notebook = {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  sections: Section[];
  course?: { name: string } | null;
};

type PageLocation = { page: NotePage; notebook: Notebook; section: Section };
type Creating =
  | { kind: 'notebook' }
  | { kind: 'section'; notebookId: string }
  | { kind: 'page'; sectionId: string }
  | null;

type Draft = {
  pageId: string;
  title: string;
  content: string;
  baseRevision: number;
  updatedAt: number;
};

type Snapshot = {
  id: string;
  title: string;
  content: string;
  revision: number;
  reason: string;
  createdAt: string;
  createdBy: Person | null;
};

type PageComment = {
  id: string;
  content: string;
  anchor: string | null;
  resolved: boolean;
  createdAt: string;
  user: Person;
};

type Presence = { id: string; lastSeenAt: string; user: Person };

type SearchResult = {
  id: string;
  type: string;
  title: string;
  snippet: string;
  subject?: string | null;
  topic?: string | null;
};

type QuestionDetail = {
  id: number;
  content: string;
  topic: string;
  marks: number;
  images: string[];
  number: number;
  part: string;
  sub_part: string;
  year: number;
  session: string;
  paper_number: number;
  subject_name: string;
  subject_code: string;
};

const EMPTY_PAGE: Pick<NotePage, 'icon' | 'tags' | 'favorite' | 'archived' | 'linkedQuestionIds' | 'splitQuestionId' | 'revision'> = {
  icon: '',
  tags: [],
  favorite: false,
  archived: false,
  linkedQuestionIds: [],
  splitQuestionId: null,
  revision: 1,
};

/**
 * The size a note drawing is authored at on a screen with room for it.
 *
 * The canvas is clamped down to the frame on a narrow viewport (see
 * `useMeasuredCanvasWidth`); this is the ceiling, not a fixed size.
 */
const DRAWING_CANVAS_WIDTH = 760;
const DRAWING_CANVAS_HEIGHT = 420;

const stripHtml = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const draftKey = (pageId: string) => `notes-draft:${pageId}`;
const canEdit = (page: NotePage | null) => page?.accessRole !== 'viewer';
const isSharedNotebook = (notebookId: string) => notebookId === 'shared-with-me';

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function initials(person: Person) {
  return (person.name || person.email)
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

function questionCode(question: QuestionDetail) {
  return `${question.subject_code}-${question.session}${String(question.year).slice(-2)}-P${question.paper_number}-Q${question.number}${question.part || ''}${question.sub_part || ''}`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[character] || character));
}

export default function NotesTextbookPage({
  initialPageId = null,
  onPageOpened,
}: {
  /** A page named by `?pageId=` in the URL, opened once on arrival. */
  initialPageId?: string | null;
  /** Reports the open page so the shell can keep the URL shareable. */
  onPageOpened?: (pageId: string | null) => void;
} = {}) {
  const { confirm, confirmDialog } = useConfirm();
  const { data: session, status } = useSession();
  const screenContext = useScreenContext();
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNotebookId, setSelectedNotebookId] = useState<string | null>(null);
  const [selectedPage, setSelectedPage] = useState<NotePage | null>(null);
  const [openingPage, setOpeningPage] = useState(false);
  const [expandedNotebooks, setExpandedNotebooks] = useState<Set<string>>(new Set());
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [recentPageIds, setRecentPageIds] = useState<string[]>([]);
  const [creating, setCreating] = useState<Creating>(null);
  const [newName, setNewName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pageMenuId, setPageMenuId] = useState<string | null>(null);
  const [draggedPageId, setDraggedPageId] = useState<string | null>(null);

  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [previewMode, setPreviewMode] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [draftRecovery, setDraftRecovery] = useState<Draft | null>(null);
  const [conflictPage, setConflictPage] = useState<NotePage | null>(null);
  const [insertRequest, setInsertRequest] = useState<{ id: string; html: string } | null>(null);
  const [showDrawing, setShowDrawing] = useState(false);
  const [drawingUploading, setDrawingUploading] = useState(false);

  const [activePanel, setActivePanel] = useState<SidePanel>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [comments, setComments] = useState<PageComment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [includeResolved, setIncludeResolved] = useState(false);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [owner, setOwner] = useState<Person | null>(null);
  const [shareEmail, setShareEmail] = useState('');
  const [shareRole, setShareRole] = useState<'editor' | 'viewer'>('editor');
  const [presence, setPresence] = useState<Presence[]>([]);
  const [tagInput, setTagInput] = useState('');

  const [splitOpen, setSplitOpen] = useState(false);
  const [questionSearch, setQuestionSearch] = useState('');
  const [questionResults, setQuestionResults] = useState<SearchResult[]>([]);
  const [questionSearching, setQuestionSearching] = useState(false);
  const [questionSearchAttempted, setQuestionSearchAttempted] = useState(false);
  const [questionSearchError, setQuestionSearchError] = useState<string | null>(null);
  const [questionLoading, setQuestionLoading] = useState(false);
  const [question, setQuestion] = useState<QuestionDetail | null>(null);
  const [markscheme, setMarkscheme] = useState<{ content: string } | null>(null);
  const [showMarkscheme, setShowMarkscheme] = useState(false);

  const selectedPageRef = useRef<NotePage | null>(null);
  const editTitleRef = useRef('');
  const editContentRef = useRef('');
  const dirtyRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const drawingCanvasRef = useRef<DrawingCanvasHandle | null>(null);
  /**
   * The note drawing modal used a hard `width={760} className="min-w-[760px]"`
   * inside an `overflow-auto` frame. On a phone that is a canvas you must
   * scroll sideways to reach the right half of -- using the same pointer that
   * is trying to draw on it. The scratchpad and the inline drawing block both
   * solved this already; this is the same hook, now shared.
   */
  const drawingFrameRef = useRef<HTMLDivElement | null>(null);
  const drawingWidth = useMeasuredCanvasWidth(drawingFrameRef, DRAWING_CANVAS_WIDTH, showDrawing);

  useEffect(() => { selectedPageRef.current = selectedPage; }, [selectedPage]);

  /**
   * Keep the URL naming the open page.
   *
   * Held in a ref so this fires on a real change of page rather than on every
   * render that hands down a new callback identity -- the shell rebuilds
   * `onPageOpened` inline, and calling it during render would push a history
   * entry per keystroke.
   */
  const reportedPageRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const id = selectedPage?.id ?? null;
    if (reportedPageRef.current === id) return;
    reportedPageRef.current = id;
    onPageOpened?.(id);
  }, [selectedPage, onPageOpened]);

  useEffect(() => { editTitleRef.current = editTitle; }, [editTitle]);
  useEffect(() => { editContentRef.current = editContent; }, [editContent]);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  // --- Real-time collaboration: live presence + cursors via SSE -----------
  const collabSelf = session?.user
    ? { id: (session.user as { id?: string }).id ?? '', name: session.user.name, image: session.user.image }
    : null;

  const handleRemoteRevision = useCallback(
    (rev: number, savedBy: string) => {
      void rev;
      void savedBy;
      // If the local editor is clean, silently re-fetch the updated content.
      // If it's dirty, show the existing conflict banner (loadServerConflict flow).
      const page = selectedPageRef.current;
      if (!page) return;
      if (!dirtyRef.current) {
        // Silent reload — fetch the latest page content and update the editor.
        void (async () => {
          try {
            const res = await fetch(`/api/pages?pageId=${page.id}`);
            if (!res.ok) return;
            const updated = (await res.json()) as NotePage;
            selectedPageRef.current = updated;
            setSelectedPage(updated);
            setEditContent(updated.content);
            setEditTitle(updated.title);
          } catch {
            // best-effort
          }
        })();
      }
    },
    []
  );

  // Feature 5 (Yjs collaborative editing, flagged off by default via
  // isYjsCollabEnabled()): the server is the single source of truth for
  // whether this is active -- yjs-update/-updates return 501 when the flag
  // is off, and useYjsPageSync (inside RichTextEditor) falls back to null
  // on any non-ok response, so it's safe to always pass these through.
  const [yjsRemoteUpdate, setYjsRemoteUpdate] = useState<{ id: string; nonce: number } | null>(null);
  const handleYjsUpdate = useCallback((updateId: string) => {
    setYjsRemoteUpdate({ id: updateId, nonce: Date.now() });
  }, []);

  const { others: collabOthers, postCursor, postTyping } = usePageCollaboration(
    selectedPage?.id,
    collabSelf,
    handleRemoteRevision,
    handleYjsUpdate
  );

  // Build the RemoteCursor list for the editor's decoration plugin.
  const remoteCursors: RemoteCursor[] = useMemo(
    () =>
      collabOthers
        .filter((o) => o.cursorFrom !== null && o.cursorTo !== null)
        .map((o) => ({
          userId: o.userId,
          userName: o.userName,
          userColor: o.userColor,
          from: o.cursorFrom!,
          to: o.cursorTo!,
        })),
    [collabOthers]
  );

  // Derive a live presence list from the SSE channel (replaces the 45s poll).
  const livePresence: Presence[] = useMemo(
    () =>
      collabOthers.map((o) => ({
        id: o.userId,
        lastSeenAt: new Date().toISOString(),
        user: { id: o.userId, name: o.userName, email: '', image: o.userImage },
      })),
    [collabOthers]
  );
  useEffect(() => { editContentRef.current = editContent; }, [editContent]);

  // Delegates to the app-wide <Toaster> mounted in app/layout.tsx rather than
  // maintaining a second, differently-styled notification system that could
  // sit on top of it.
  const notify = useCallback((message: string) => {
    toast(message);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/notebooks');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load notebooks');
      const nextNotebooks = Array.isArray(data) ? data as Notebook[] : [];
      setNotebooks(nextNotebooks);
      setExpandedNotebooks((current) => current.size > 0 ? current : new Set(nextNotebooks.slice(0, 2).map((notebook) => notebook.id)));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load notebooks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === 'authenticated') window.setTimeout(() => void load(), 0);
    if (status === 'unauthenticated') window.setTimeout(() => setLoading(false), 0);
  }, [load, status]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('notes-recent-pages') || '[]');
      if (Array.isArray(stored)) window.setTimeout(() => setRecentPageIds(stored.filter((id): id is string => typeof id === 'string').slice(0, 12)), 0);
    } catch {
      localStorage.removeItem('notes-recent-pages');
    }
  }, []);

  const allPages = useMemo<PageLocation[]>(() => notebooks.flatMap((notebook) =>
    notebook.sections.flatMap((section) => section.pages.map((page) => ({ page, notebook, section })))
  ), [notebooks]);

  const pageById = useMemo(() => new Map(allPages.map((location) => [location.page.id, location])), [allPages]);

  const flatResults = useMemo(() => {
    const query = (commandOpen ? commandQuery : searchQuery).trim().toLowerCase();
    let locations = allPages;
    if (query) {
      locations = locations.filter(({ page, notebook, section }) =>
        `${page.title} ${page.tags.join(' ')} ${notebook.name} ${section.name} ${stripHtml(page.content)}`.toLowerCase().includes(query)
      );
    }
    if (filterMode === 'favorites') locations = locations.filter(({ page }) => page.favorite && !page.archived);
    if (filterMode === 'archive') locations = locations.filter(({ page }) => page.archived);
    if (filterMode === 'recent') {
      const order = new Map(recentPageIds.map((id, index) => [id, index]));
      locations = locations.filter(({ page }) => order.has(page.id)).sort((a, b) => (order.get(a.page.id) ?? 99) - (order.get(b.page.id) ?? 99));
    }
    return locations.slice(0, commandOpen ? 30 : 100);
  }, [allPages, commandOpen, commandQuery, filterMode, recentPageIds, searchQuery]);

  const replacePage = useCallback((updated: NotePage) => {
    setNotebooks((current) => current.map((notebook) => ({
      ...notebook,
      sections: notebook.sections.map((section) => ({
        ...section,
        pages: section.pages.map((page) => page.id === updated.id ? { ...page, ...updated } : page),
      })),
    })));
  }, []);

  const removePageLocally = useCallback((pageId: string) => {
    setNotebooks((current) => current.map((notebook) => ({
      ...notebook,
      sections: notebook.sections.map((section) => ({ ...section, pages: section.pages.filter((page) => page.id !== pageId) })),
    })));
  }, []);

  const openPage = useCallback(async (pageId: string) => {
    setPageMenuId(null);
    setOpeningPage(true);
    setConflictPage(null);
    setDraftRecovery(null);
    setActivePanel(null);
    setSelectedText('');
    try {
      const response = await fetch(`/api/pages?pageId=${encodeURIComponent(pageId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to open page');
      const page = { ...EMPTY_PAGE, ...data } as NotePage;
      selectedPageRef.current = page;
      setSelectedPage(page);
      setEditTitle(page.title);
      setEditContent(page.content);
      setPreviewMode(false);
      setTagInput(page.tags.join(', '));
      setDirty(false);
      setSaveState('saved');
      setSelectedNotebookId(pageById.get(pageId)?.notebook.id ?? null);
      setSidebarOpen(false);

      const nextRecent = [pageId, ...recentPageIds.filter((id) => id !== pageId)].slice(0, 12);
      setRecentPageIds(nextRecent);
      localStorage.setItem('notes-recent-pages', JSON.stringify(nextRecent));

      try {
        const stored = localStorage.getItem(draftKey(pageId));
        if (stored) {
          const draft = JSON.parse(stored) as Draft;
          const differs = draft.title !== page.title || draft.content !== page.content;
          if (draft.pageId === pageId && differs) setDraftRecovery(draft);
          else localStorage.removeItem(draftKey(pageId));
        }
      } catch {
        localStorage.removeItem(draftKey(pageId));
      }
    } catch (openError) {
      notify(openError instanceof Error ? openError.message : 'Failed to open page');
    } finally {
      setOpeningPage(false);
    }
  }, [notify, pageById, recentPageIds]);

  /**
   * Open the page a link arrived with. Runs on the id, not on mount, so a
   * second link to a different page while the workspace is already open still
   * navigates. `openPage` fetches by id and does not need the tree loaded, so
   * this works before the notebook list has arrived.
   */
  const openedFromUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialPageId || openedFromUrlRef.current === initialPageId) return;
    if (selectedPageRef.current?.id === initialPageId) return;
    openedFromUrlRef.current = initialPageId;
    void openPage(initialPageId);
  }, [initialPageId, openPage]);

  const savePage = useCallback(async (options?: { manual?: boolean; force?: boolean }) => {
    const page = selectedPageRef.current;
    if (!page || !canEdit(page) || saveInFlightRef.current) return null;
    const title = editTitleRef.current.trim() || 'Untitled page';
    const content = editContentRef.current;
    if (!options?.manual && !options?.force && title === page.title && content === page.content) {
      setDirty(false);
      setSaveState('saved');
      localStorage.removeItem(draftKey(page.id));
      return page;
    }

    saveInFlightRef.current = true;
    setSaveState('saving');
    try {
      const response = await fetch('/api/pages', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageId: page.id,
          ...(!options?.force && { baseRevision: page.revision }),
          title,
          content,
          createSnapshot: Boolean(options?.manual),
          snapshotReason: options?.manual ? 'manual' : 'autosave',
        }),
      });
      const data = await response.json();
      if (response.status === 409) {
        setConflictPage(data.serverPage as NotePage);
        setSaveState('conflict');
        return null;
      }
      if (!response.ok) throw new Error(data.error || 'Failed to save page');
      const updated = { ...page, ...data } as NotePage;
      selectedPageRef.current = updated;
      setSelectedPage(updated);
      replacePage(updated);
      if (editTitleRef.current.trim() === title && editContentRef.current === content) {
        setDirty(false);
        localStorage.removeItem(draftKey(page.id));
      }
      setConflictPage(null);
      setSaveState('saved');
      if (options?.manual) notify('Version saved');
      return updated;
    } catch (saveError) {
      setSaveState(navigator.onLine ? 'error' : 'offline');
      if (options?.manual) notify(saveError instanceof Error ? saveError.message : 'Failed to save page');
      return null;
    } finally {
      saveInFlightRef.current = false;
    }
  }, [notify, replacePage]);

  useEffect(() => {
    const page = selectedPageRef.current;
    if (!page || !dirty || !canEdit(page) || conflictPage) return;
    const timer = window.setTimeout(() => void savePage(), 1300);
    return () => window.clearTimeout(timer);
  }, [conflictPage, dirty, editContent, editTitle, savePage, selectedPage?.revision]);

  useEffect(() => {
    const page = selectedPageRef.current;
    if (!page || !dirty || !canEdit(page)) return;
    const draft: Draft = {
      pageId: page.id,
      title: editTitle,
      content: editContent,
      baseRevision: page.revision,
      updatedAt: Date.now(),
    };
    localStorage.setItem(draftKey(page.id), JSON.stringify(draft));
  }, [dirty, editContent, editTitle, selectedPage?.id, selectedPage?.revision]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const online = () => {
      if (dirty) void savePage();
    };
    const offline = () => setSaveState('offline');
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [dirty, savePage]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((open) => !open);
        setCommandQuery('');
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void savePage({ manual: true });
      }
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [savePage]);

  useEffect(() => {
    if (!selectedPage) return;
    screenContext.update({
      tab: 'materials',
      description: `Editing note: ${editTitle || selectedPage.title}`,
      data: {
        noteId: selectedPage.id,
        noteTitle: editTitle || selectedPage.title,
        noteContent: stripHtml(editContent).slice(0, 4000),
        noteSelection: selectedText.slice(0, 1500),
      },
    });
    // The context provider exposes a stable update function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editContent, editTitle, selectedPage?.id, selectedText]);

  const patchMetadata = useCallback(async (changes: Partial<Pick<NotePage, 'icon' | 'tags' | 'favorite' | 'archived' | 'linkedQuestionIds' | 'splitQuestionId'>>) => {
    if (dirty) await savePage();
    const page = selectedPageRef.current;
    if (!page || !canEdit(page)) return null;
    try {
      const response = await fetch('/api/pages', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: page.id, baseRevision: page.revision, ...changes }),
      });
      const data = await response.json();
      if (response.status === 409) {
        setConflictPage(data.serverPage as NotePage);
        setSaveState('conflict');
        return null;
      }
      if (!response.ok) throw new Error(data.error || 'Could not update page');
      const updated = { ...page, ...data } as NotePage;
      selectedPageRef.current = updated;
      setSelectedPage(updated);
      replacePage(updated);
      return updated;
    } catch (metadataError) {
      notify(metadataError instanceof Error ? metadataError.message : 'Could not update page');
      return null;
    }
  }, [dirty, notify, replacePage, savePage]);

  const handleCreate = async () => {
    if (!creating || !newName.trim()) return;
    const createTarget = creating;
    const targetNotebookId = createTarget.kind === 'page'
      ? notebooks.find((notebook) => notebook.sections.some((section) => section.id === createTarget.sectionId))?.id ?? null
      : createTarget.kind === 'section'
        ? createTarget.notebookId
        : null;
    setSubmitting(true);
    try {
      let response: Response;
      if (createTarget.kind === 'notebook') {
        response = await fetch('/api/notebooks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: newName.trim() }),
        });
      } else if (createTarget.kind === 'section') {
        response = await fetch('/api/sections', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notebookId: createTarget.notebookId, name: newName.trim() }),
        });
      } else {
        response = await fetch('/api/pages', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sectionId: createTarget.sectionId, title: newName.trim() }),
        });
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not create item');
      await load();
      if (createTarget.kind === 'page') {
        await openPage(data.id);
        setExpandedSections((current) => new Set(current).add(createTarget.sectionId));
        if (targetNotebookId) {
          setSelectedNotebookId(targetNotebookId);
          setExpandedNotebooks((current) => new Set(current).add(targetNotebookId));
        }
      } else if (createTarget.kind === 'section' && targetNotebookId) {
        setSelectedNotebookId(targetNotebookId);
        setExpandedNotebooks((current) => new Set(current).add(targetNotebookId));
        if (data.id) setExpandedSections((current) => new Set(current).add(data.id));
      }
      setCreating(null);
      setNewName('');
    } catch (createError) {
      notify(createError instanceof Error ? createError.message : 'Could not create item');
    } finally {
      setSubmitting(false);
    }
  };

  const deletePage = async (pageId: string) => {
    const ok = await confirm({
      title: 'Delete this page?',
      message:
        'The page and its whole version history go with it. Anyone you shared it with loses access. This cannot be undone.',
      confirmLabel: 'Delete page',
    });
    if (!ok) return;
    try {
      const response = await fetch(`/api/pages?pageId=${encodeURIComponent(pageId)}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not delete page');
      removePageLocally(pageId);
      if (selectedPageRef.current?.id === pageId) {
        selectedPageRef.current = null;
        setSelectedPage(null);
      }
      notify('Page deleted');
    } catch (deleteError) {
      notify(deleteError instanceof Error ? deleteError.message : 'Could not delete page');
    }
  };

  const duplicatePage = async (pageId: string) => {
    const source = pageById.get(pageId);
    const targetSection = source && !isSharedNotebook(source.notebook.id)
      ? source.section
      : notebooks.find((notebook) => !isSharedNotebook(notebook.id))?.sections[0];
    if (!source || !targetSection) return notify('Create a section before duplicating this page');
    try {
      const response = await fetch('/api/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionId: targetSection.id, title: `${source.page.title} copy`, duplicatePageId: pageId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not duplicate page');
      await load();
      await openPage(data.id);
      notify('Page duplicated');
    } catch (duplicateError) {
      notify(duplicateError instanceof Error ? duplicateError.message : 'Could not duplicate page');
    }
  };

  const reorderPages = useCallback(async (sectionId: string, orderedPageIds: string[]) => {
    const before = notebooks;
    setNotebooks((current) => current.map((notebook) => ({
      ...notebook,
      sections: notebook.sections.map((section) => section.id !== sectionId ? section : {
        ...section,
        pages: orderedPageIds.map((id, order) => ({ ...section.pages.find((page) => page.id === id)!, order })),
      }),
    })));
    try {
      const response = await fetch('/api/pages', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sectionId, orderedPageIds }),
      });
      if (!response.ok) throw new Error('Could not reorder pages');
    } catch {
      setNotebooks(before);
      notify('Page order could not be saved');
    }
  }, [notebooks, notify]);

  const movePageByOffset = (pageId: string, offset: number) => {
    const location = pageById.get(pageId);
    if (!location || isSharedNotebook(location.notebook.id)) return;
    const ids = location.section.pages.map((page) => page.id);
    const index = ids.indexOf(pageId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void reorderPages(location.section.id, ids);
  };

  const dropPage = (event: DragEvent, targetPageId: string) => {
    event.preventDefault();
    const source = draggedPageId ? pageById.get(draggedPageId) : null;
    const target = pageById.get(targetPageId);
    setDraggedPageId(null);
    if (!source || !target || source.section.id !== target.section.id || source.page.id === target.page.id) return;
    const ids = target.section.pages.map((page) => page.id).filter((id) => id !== source.page.id);
    ids.splice(ids.indexOf(target.page.id), 0, source.page.id);
    void reorderPages(target.section.id, ids);
  };

  const movePageToSection = async (sectionId: string) => {
    if (dirty) await savePage();
    const page = selectedPageRef.current;
    if (!page || page.sectionId === sectionId || page.accessRole !== 'owner') return;
    try {
      const response = await fetch('/api/pages', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId: page.id, baseRevision: page.revision, sectionId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not move page');
      await load();
      await openPage(page.id);
      notify('Page moved');
    } catch (moveError) {
      notify(moveError instanceof Error ? moveError.message : 'Could not move page');
    }
  };

  const loadPanel = useCallback(async (panel: Exclude<SidePanel, null>, pageId: string) => {
    setPanelLoading(true);
    try {
      if (panel === 'history') {
        const response = await fetch(`/api/pages/${pageId}/history`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load history');
        setSnapshots(data.snapshots || []);
      } else if (panel === 'comments') {
        const response = await fetch(`/api/pages/${pageId}/comments?resolved=${includeResolved}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load comments');
        setComments(data.comments || []);
      } else if (panel === 'share') {
        const response = await fetch(`/api/pages/${pageId}/collaborators`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load collaborators');
        setCollaborators(data.collaborators || []);
        setOwner(data.owner || null);
      }
    } catch (panelError) {
      notify(panelError instanceof Error ? panelError.message : 'Could not load panel');
    } finally {
      setPanelLoading(false);
    }
  }, [includeResolved, notify]);

  const openPanel = (panel: Exclude<SidePanel, null>) => {
    if (!selectedPage) return;
    setSplitOpen(false);
    setActivePanel((current) => current === panel ? null : panel);
    if (activePanel !== panel) void loadPanel(panel, selectedPage.id);
  };

  useEffect(() => {
    if (activePanel === 'comments' && selectedPage) window.setTimeout(() => void loadPanel('comments', selectedPage.id), 0);
  }, [activePanel, includeResolved, loadPanel, selectedPage]);

  // Presence is now driven by the real-time SSE channel (usePageCollaboration).
  // The legacy 45s polling fallback is kept only as a recovery mechanism in
  // case the SSE stream fails to connect (e.g. ad blocker / network issue).
  useEffect(() => {
    const pageId = selectedPage?.id;
    if (!pageId) return;
    // Only poll if we have no live SSE presence after 10s — a single check.
    const fallbackTimer = window.setTimeout(async () => {
      if (livePresence.length > 0) return; // SSE is working
      try {
        const response = await fetch(`/api/pages/${pageId}/presence`, { method: 'POST' });
        if (response.ok) setPresence((await response.json()).presence || []);
      } catch {
        // best-effort
      }
    }, 10_000);
    return () => window.clearTimeout(fallbackTimer);
  }, [selectedPage?.id, livePresence.length]);

  // Compute the effective presence list: prefer live SSE data, fall back to
  // the polled presence state (which only fills in if SSE hasn't connected).
  const effectivePresence = livePresence.length > 0 ? livePresence : presence;

  const restoreSnapshot = async (snapshotId: string) => {
    const page = selectedPageRef.current;
    if (!page) return;
    const ok = await confirm({
      title: 'Restore this version?',
      message:
        'The page goes back to how it was at this point. Nothing is lost — what is there now is kept in the history, so you can restore it again.',
      confirmLabel: 'Restore version',
      destructive: false,
    });
    if (!ok) return;
    try {
      const response = await fetch(`/api/pages/${page.id}/history`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshotId, baseRevision: page.revision }),
      });
      const data = await response.json();
      if (response.status === 409) {
        setConflictPage(data.serverPage);
        setSaveState('conflict');
        return;
      }
      if (!response.ok) throw new Error(data.error || 'Could not restore version');
      const restored = { ...page, ...data } as NotePage;
      selectedPageRef.current = restored;
      setSelectedPage(restored);
      setEditTitle(restored.title);
      setEditContent(restored.content);
      setDirty(false);
      replacePage(restored);
      await loadPanel('history', page.id);
      notify('Version restored');
    } catch (restoreError) {
      notify(restoreError instanceof Error ? restoreError.message : 'Could not restore version');
    }
  };

  const addComment = async () => {
    const page = selectedPageRef.current;
    if (!page || !commentText.trim()) return;
    try {
      const response = await fetch(`/api/pages/${page.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: commentText.trim(), anchor: selectedText || null }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not add comment');
      setComments((current) => [data.comment, ...current]);
      setCommentText('');
    } catch (commentError) {
      notify(commentError instanceof Error ? commentError.message : 'Could not add comment');
    }
  };

  const resolveComment = async (comment: PageComment) => {
    if (!selectedPage) return;
    const response = await fetch(`/api/pages/${selectedPage.id}/comments`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commentId: comment.id, resolved: !comment.resolved }),
    });
    if (response.ok) {
      const data = await response.json();
      setComments((current) => current.map((item) => item.id === comment.id ? data.comment : item));
    }
  };

  const inviteCollaborator = async () => {
    if (!selectedPage || !shareEmail.trim()) return;
    try {
      const response = await fetch(`/api/pages/${selectedPage.id}/collaborators`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: shareEmail.trim(), role: shareRole }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not share page');
      setCollaborators((current) => [...current.filter((item) => item.userId !== data.collaborator.userId), data.collaborator]);
      setShareEmail('');
      notify('Page shared');
    } catch (shareError) {
      notify(shareError instanceof Error ? shareError.message : 'Could not share page');
    }
  };

  const removeCollaborator = async (userId: string) => {
    if (!selectedPage) return;
    const response = await fetch(`/api/pages/${selectedPage.id}/collaborators?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
    if (response.ok) setCollaborators((current) => current.filter((item) => item.userId !== userId));
  };

  useEffect(() => {
    const query = questionSearch.trim();
    if (query.length < 2) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
          if (!response.ok) throw new Error(`Search failed with status ${response.status}`);
          const data = await response.json();
          if (controller.signal.aborted) return;
          setQuestionResults((data.results || []).filter((result: SearchResult) => result.type === 'question'));
          setQuestionSearchAttempted(true);
        } catch (searchError) {
          if (controller.signal.aborted || (searchError instanceof DOMException && searchError.name === 'AbortError')) return;
          setQuestionResults([]);
          setQuestionSearchError('Could not search questions. Please try again.');
          setQuestionSearchAttempted(true);
        } finally {
          if (!controller.signal.aborted) setQuestionSearching(false);
        }
      })();
    }, 350);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [questionSearch]);

  const loadQuestion = useCallback(async (questionId: number, persist = true) => {
    setQuestionLoading(true);
    setShowMarkscheme(false);
    try {
      const response = await fetch(`/api/questions?action=question&id=${questionId}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load question');
      setQuestion(data.question);
      setMarkscheme(data.markscheme || null);
      if (persist && selectedPageRef.current) {
        const linked = [...new Set([...selectedPageRef.current.linkedQuestionIds, questionId])];
        await patchMetadata({ splitQuestionId: questionId, linkedQuestionIds: linked });
      }
    } catch (questionError) {
      notify(questionError instanceof Error ? questionError.message : 'Could not load question');
    } finally {
      setQuestionLoading(false);
    }
  }, [notify, patchMetadata]);

  useEffect(() => {
    if (selectedPage?.splitQuestionId && question?.id !== selectedPage.splitQuestionId) window.setTimeout(() => void loadQuestion(selectedPage.splitQuestionId!, false), 0);
    else {
      window.setTimeout(() => { setQuestion(null); setMarkscheme(null); }, 0);
    }
  }, [loadQuestion, question?.id, selectedPage?.id, selectedPage?.splitQuestionId]);

  const insertQuestionIntoNote = () => {
    if (!question) return;
    const code = questionCode(question);
    const text = stripHtml(question.content);
    setInsertRequest({
      id: `${question.id}:${Date.now()}`,
      html: `<blockquote><p><strong>${escapeHtml(code)}</strong></p><p>${escapeHtml(text)}</p></blockquote><p></p>`,
    });
    notify('Question inserted into note');
  };

  const insertDrawingIntoNote = async (dataUrl: string) => {
    const page = selectedPageRef.current;
    if (!page || !canEdit(page)) return notify('Choose an editable page first');
    const strokes = drawingCanvasRef.current?.exportStrokes();
    if (!strokes) return notify('Draw something first');
    setDrawingUploading(true);
    try {
      const blob = await fetch(dataUrl).then((response) => response.blob());
      const file = new File([blob], `note-drawing-${Date.now()}.png`, { type: 'image/png' });
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await response.json();
      if (!response.ok || !data.fileUrl) throw new Error(data.error || 'Could not upload drawing');

      // Create the PageDrawing row up front so the drawingBlock node can
      // reference it from the moment it's inserted -- create-on-first-edit
      // would leave a node with nothing to reopen if the page were closed
      // before the drawing was ever re-saved.
      const drawingResponse = await fetch('/api/page-drawings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageId: page.id,
          strokesJson: strokes,
          thumbnailUrl: data.fileUrl,
          width: 760,
          height: 420,
        }),
      });
      const drawingData = await drawingResponse.json();
      if (!drawingResponse.ok || !drawingData.drawing) {
        throw new Error(drawingData.error || 'Could not save drawing');
      }

      setInsertRequest({
        id: `drawing:${Date.now()}`,
        html: `<div data-type="drawing-block" data-drawing-id="${escapeHtml(String(drawingData.drawing.id))}" data-thumbnail-url="${escapeHtml(String(data.fileUrl))}" data-width="760" data-height="420"><img src="${escapeHtml(String(data.fileUrl))}" alt="Note drawing" /></div><p></p>`,
      });
      setShowDrawing(false);
      notify('Drawing inserted into note');
    } catch (drawingError) {
      notify(drawingError instanceof Error ? drawingError.message : 'Could not insert drawing');
    } finally {
      setDrawingUploading(false);
    }
  };

  const addReview = async () => {
    const page = selectedPageRef.current;
    const selection = selectedText.trim();
    if (!page || !selection) return notify('Select text in the note first');
    try {
      const response = await fetch('/api/learning/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: selection,
          answer: stripHtml(editContentRef.current).slice(0, 5000) || selection,
          subject: pageById.get(page.id)?.notebook.name || 'Notes',
          topic: page.tags[0] || page.title,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not add review');
      notify('Added to spaced review');
    } catch (reviewError) {
      notify(reviewError instanceof Error ? reviewError.message : 'Could not add review');
    }
  };

  const addStudyTask = async () => {
    const page = selectedPageRef.current;
    if (!page) return;
    const dueAt = new Date();
    dueAt.setDate(dueAt.getDate() + 1);
    dueAt.setHours(17, 0, 0, 0);
    try {
      const response = await fetch('/api/learning/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Review note: ${page.title}`,
          subject: pageById.get(page.id)?.notebook.name || 'Notes',
          topic: page.tags[0] || page.title,
          taskType: 'notes',
          dueAt: dueAt.toISOString(),
          durationMinutes: 20,
          questionId: page.splitQuestionId,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not add task');
      notify('Study task added for tomorrow');
    } catch (taskError) {
      notify(taskError instanceof Error ? taskError.message : 'Could not add study task');
    }
  };

  const openAI = (quiz = false) => {
    const source = selectedText.trim() || stripHtml(editContentRef.current).slice(0, 2500);
    const prompt = quiz
      ? `Quiz me on this note. Ask one question at a time and wait for my answer before giving feedback.\n\n${source}`
      : `Help me understand and improve these notes. Focus on the selected passage if one is provided.\n\n${source}`;
    window.dispatchEvent(new CustomEvent('open-ai-assistant', { detail: { prompt, mode: quiz ? 'check' : 'explain' } }));
  };

  const recoverDraft = () => {
    if (!draftRecovery) return;
    setEditTitle(draftRecovery.title);
    setEditContent(draftRecovery.content);
    setDirty(true);
    setDraftRecovery(null);
    notify('Local draft recovered');
  };

  const discardDraft = () => {
    if (!selectedPage) return;
    localStorage.removeItem(draftKey(selectedPage.id));
    setDraftRecovery(null);
  };

  const loadServerConflict = () => {
    if (!conflictPage) return;
    const server = { ...EMPTY_PAGE, ...conflictPage } as NotePage;
    selectedPageRef.current = server;
    setSelectedPage(server);
    setEditTitle(server.title);
    setEditContent(server.content);
    setConflictPage(null);
    setDirty(false);
    setSaveState('saved');
    localStorage.removeItem(draftKey(server.id));
    replacePage(server);
  };

  const toggleNotebook = (notebookId: string) => setExpandedNotebooks((current) => {
    const next = new Set(current);
    if (next.has(notebookId)) next.delete(notebookId); else next.add(notebookId);
    return next;
  });

  const toggleSection = (sectionId: string) => setExpandedSections((current) => {
    const next = new Set(current);
    if (next.has(sectionId)) next.delete(sectionId); else next.add(sectionId);
    return next;
  });

  const editableSections = notebooks
    .filter((notebook) => !isSharedNotebook(notebook.id))
    .flatMap((notebook) => notebook.sections.map((section) => ({ ...section, notebookName: notebook.name })));

  const defaultPageSectionId = useMemo(() => {
    const selectedLocation = selectedPage ? pageById.get(selectedPage.id) : null;
    if (selectedLocation && !isSharedNotebook(selectedLocation.notebook.id)) return selectedLocation.section.id;

    const selectedNotebook = selectedNotebookId ? notebooks.find((notebook) => notebook.id === selectedNotebookId) : null;
    if (selectedNotebook && !isSharedNotebook(selectedNotebook.id)) return selectedNotebook.sections[0]?.id ?? null;

    return notebooks.find((notebook) => !isSharedNotebook(notebook.id))?.sections[0]?.id ?? null;
  }, [notebooks, pageById, selectedNotebookId, selectedPage]);

  const startCreatePage = useCallback((sectionId?: string | null) => {
    const targetSectionId = sectionId ?? defaultPageSectionId;
    if (!targetSectionId) {
      notify('Create a section before adding a page');
      return;
    }
    setCreating({ kind: 'page', sectionId: targetSectionId });
    setNewName('');
  }, [defaultPageSectionId, notify]);

  const renderPageRow = (location: PageLocation) => {
    const { page, notebook } = location;
    const isOwner = !isSharedNotebook(notebook.id);
    return (
      <div
        key={page.id}
        draggable={isOwner}
        onDragStart={() => setDraggedPageId(page.id)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => dropPage(event, page.id)}
        className={`group relative flex min-h-9 items-center gap-2 rounded-md px-2 text-sm ${
          selectedPage?.id === page.id
            ? 'bg-accent-subtle text-accent-text'
            : 'text-secondary hover:bg-surface-hover'
        }`}
      >
        <button className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left" onClick={() => void openPage(page.id)}>
          <span className="w-4 shrink-0 text-center">{page.icon || <FileText className="h-3.5 w-3.5" />}</span>
          <span className="truncate">{page.title}</span>
          {page.favorite && <Star className="h-3 w-3 shrink-0 fill-warning text-warning" />}
          {page.collaborators && page.collaborators.length > 0 && <Users className="h-3 w-3 shrink-0 text-secondary" />}
        </button>
        <button
          onClick={() => setPageMenuId((current) => current === page.id ? null : page.id)}
          className="shrink-0 rounded-sm p-1 text-muted hover:bg-surface hover:text-secondary"
          title="Page actions" aria-label="Page actions"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </button>
        {pageMenuId === page.id && (
          <div className="absolute right-1 top-9 z-30 w-48 rounded-md border border-line bg-surface p-1 shadow-overlay">
            {page.accessRole !== 'viewer' && (
              <button onClick={() => { void openPage(page.id).then(() => patchMetadata({ favorite: !page.favorite })); setPageMenuId(null); }} className="menu-row">
                <Star className="h-4 w-4" /> {page.favorite ? 'Remove favorite' : 'Add favorite'}
              </button>
            )}
            <button onClick={() => { void duplicatePage(page.id); setPageMenuId(null); }} className="menu-row">
              <Copy className="h-4 w-4" /> Duplicate
            </button>
            {isOwner && <>
              <button onClick={() => { movePageByOffset(page.id, -1); setPageMenuId(null); }} className="menu-row"><ChevronRight className="h-4 w-4 -rotate-90" /> Move up</button>
              <button onClick={() => { movePageByOffset(page.id, 1); setPageMenuId(null); }} className="menu-row"><ChevronRight className="h-4 w-4 rotate-90" /> Move down</button>
              <button onClick={() => { void openPage(page.id).then(() => patchMetadata({ archived: !page.archived })); setPageMenuId(null); }} className="menu-row">
                {page.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />} {page.archived ? 'Restore' : 'Archive'}
              </button>
              <button onClick={() => { void deletePage(page.id); setPageMenuId(null); }} className="menu-row text-danger">
                <Trash2 className="h-4 w-4" /> Delete
              </button>
            </>}
          </div>
        )}
      </div>
    );
  };

  // Signed-out visitors used to get the full workspace chrome and a "Create
  // your first notebook" prompt — every button behind which 401s. Ask them to
  // sign in instead, matching how Study handles the same state.
  if (status === 'unauthenticated') {
    return (
      <div className="grid h-full min-h-[400px] place-items-center p-6">
        <div className="max-w-md text-center">
          <NotebookIcon className="mx-auto mb-4 h-10 w-10 text-accent-text" />
          <h2 className="text-xl font-bold text-primary">
            Sign in to use your notebook
          </h2>
          <p className="mt-2 text-sm text-secondary">
            Your notebooks, pages, and drawings are private to your account.
          </p>
          <a
            href="/auth/login"
            className="mt-5 inline-flex rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover"
          >
            Sign in
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-[600px] overflow-hidden bg-surface text-primary">
      {confirmDialog}
      {sidebarOpen && <button aria-label="Close notes navigation" className="fixed inset-0 z-30 bg-black/35 lg:hidden" onClick={() => setSidebarOpen(false)} />}

      <aside className={`fixed inset-y-0 left-0 z-40 flex w-[min(88vw,340px)] flex-col border-r border-line bg-surface-raised transition-transform lg:relative lg:inset-auto lg:z-20 lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'} ${sidebarCollapsed ? 'lg:hidden' : ''}`}>
        <div className="border-b border-line p-3">
          <div className="mb-3 flex items-center gap-2">
            <NotebookIcon className="h-4 w-4 text-accent-text" />
            <h2 className="text-sm font-semibold">Notes</h2>
            <span className="ml-auto text-xs text-muted">{allPages.length} pages</span>
            <button onClick={() => setSidebarCollapsed(true)} className="hidden rounded-sm p-1.5 text-muted hover:bg-surface-active lg:block" title="Hide navigation" aria-label="Hide navigation"><PanelLeftClose className="h-4 w-4" /></button>
            <button onClick={() => setSidebarOpen(false)} className="rounded-sm p-1.5 text-muted hover:bg-surface-active lg:hidden" title="Close navigation" aria-label="Close navigation"><X className="h-4 w-4" /></button>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted" />
            <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="e.g. cell respiration, revision, or chapter 5 notes" className="h-9 w-full rounded-md border border-line bg-surface pl-8 pr-9 text-sm outline-none focus:border-accent" />
            <button onClick={() => { setCommandOpen(true); setCommandQuery(''); }} className="absolute right-2 top-2 rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-muted" title="Quick navigation" aria-label="Quick navigation">⌘K</button>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-1" aria-label="Page filters">
            {([
              ['all', FileText, 'All'],
              ['favorites', Star, 'Favorites'],
              ['recent', Clock3, 'Recent'],
              ['archive', Archive, 'Archive'],
            ] as const).map(([mode, Icon, label]) => (
              <button key={mode} onClick={() => setFilterMode(mode)} title={label} aria-label={label} className={`flex h-8 items-center justify-center rounded-md ${filterMode === mode ? 'bg-surface text-accent-text' : 'text-muted hover:bg-surface-hover'}`}>
                <Icon className="h-4 w-4" />
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 border-b border-line p-2">
          <button onClick={() => { setCreating({ kind: 'notebook' }); setNewName(''); }} className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-2 text-xs font-semibold text-white hover:bg-accent-hover"><Plus className="h-3.5 w-3.5" /> Notebook</button>
          <button
            onClick={() => startCreatePage()}
            disabled={!defaultPageSectionId}
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-strong bg-surface px-2 text-xs font-medium hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
            title={defaultPageSectionId ? 'Add page' : 'Create a section before adding a page'} aria-label={defaultPageSectionId ? 'Add page' : 'Create a section before adding a page'}
          >
            <Plus className="h-3.5 w-3.5" /> Page
          </button>
          {selectedNotebookId && !isSharedNotebook(selectedNotebookId) && (
            <button onClick={() => { setCreating({ kind: 'section', notebookId: selectedNotebookId }); setNewName(''); }} className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-strong bg-surface px-2 text-xs font-medium hover:bg-surface-hover"><FolderPlus className="h-3.5 w-3.5" /> Section</button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading</div>
          ) : error ? (
            <div className="p-4 text-center text-sm text-danger"><p>{error}</p><button onClick={() => void load()} className="mt-2 underline">Retry</button></div>
          ) : searchQuery || filterMode !== 'all' ? (
            <div className="space-y-1">
              {flatResults.map(renderPageRow)}
              {flatResults.length === 0 && <p className="px-3 py-10 text-center text-sm text-muted">No matching pages</p>}
            </div>
          ) : notebooks.length === 0 ? (
            <div className="px-6 py-14 text-center text-muted"><NotebookIcon className="mx-auto mb-3 h-8 w-8 opacity-50" /><p className="text-sm font-medium">Create your first notebook</p></div>
          ) : (
            <div className="space-y-2">
              {notebooks.map((notebook) => {
                const expanded = expandedNotebooks.has(notebook.id);
                return (
                  <div key={notebook.id}>
                    <div className={`flex items-center rounded-md ${selectedNotebookId === notebook.id ? 'bg-surface-active/70 bg-surface' : 'hover:bg-surface-hover'}`}>
                      <button onClick={() => { setSelectedNotebookId(notebook.id); toggleNotebook(notebook.id); }} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-sm font-semibold">
                        {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-muted" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted" />}
                        <span>{notebook.icon || '📓'}</span><span className="truncate">{notebook.name}</span>
                      </button>
                    </div>
                    {expanded && (
                      <div className="ml-3 mt-1 space-y-1 border-l border-line pl-2">
                        {notebook.sections.map((section) => {
                          const sectionExpanded = expandedSections.has(section.id);
                          const pages = section.pages.filter((page) => !page.archived);
                          return (
                            <div key={section.id}>
                              <div className="group flex items-center rounded-md hover:bg-surface-hover">
                                <button onClick={() => toggleSection(section.id)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs font-medium text-secondary">
                                  {sectionExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                                  <BookOpen className="h-3.5 w-3.5" /><span className="truncate">{section.name}</span>
                                </button>
                                {!isSharedNotebook(notebook.id) && <button onClick={() => startCreatePage(section.id)} className="mr-1 rounded-sm p-1 text-muted hover:bg-surface hover:text-accent-text" title="Add page" aria-label="Add page"><Plus className="h-3.5 w-3.5" /></button>}
                              </div>
                              {sectionExpanded && (
                                <div className="ml-3 space-y-0.5">
                                  {pages.map((page) => renderPageRow({ page, notebook, section }))}
                                  {pages.length === 0 && (
                                    <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted">
                                      <span className="flex-1">No pages</span>
                                      {!isSharedNotebook(notebook.id) && (
                                        <button onClick={() => startCreatePage(section.id)} className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface px-2 py-1 font-medium text-secondary hover:border-accent-border hover:text-accent-text">
                                          <Plus className="h-3 w-3" /> Page
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex min-h-14 items-center gap-2 border-b border-line bg-surface px-3 sm:px-4">
          <button onClick={() => { if (sidebarCollapsed) setSidebarCollapsed(false); else setSidebarOpen(true); }} className="rounded-md p-2 text-muted hover:bg-surface-hover" title="Open notes navigation" aria-label="Open notes navigation"><Menu className="h-5 w-5" /></button>
          {selectedPage ? <>
            <span className="hidden text-xl sm:block">{selectedPage.icon || '📝'}</span>
            <input
              value={editTitle}
              readOnly={!canEdit(selectedPage)}
              onChange={(event) => { setEditTitle(event.target.value); setDirty(true); }}
              className="min-w-0 flex-1 border-0 bg-transparent text-base font-semibold outline-none sm:text-lg"
              aria-label="Page title"
            />
            <div className="hidden items-center gap-1 xl:flex">
              <button onClick={() => void addReview()} className="toolbar-command" title="Add selected text to spaced review" aria-label="Add selected text to spaced review"><RefreshCw className="h-4 w-4" /><span>Review</span></button>
              <button onClick={() => void addStudyTask()} className="toolbar-command" title="Add a study task" aria-label="Add a study task"><Zap className="h-4 w-4" /><span>Task</span></button>
              {canEdit(selectedPage) && <button onClick={() => setShowDrawing(true)} className="toolbar-command" title="Draw and insert" aria-label="Draw and insert"><PenTool className="h-4 w-4" /><span>Draw</span></button>}
              <button onClick={() => openAI(false)} className="toolbar-command" title="Ask AI about this note" aria-label="Ask AI about this note"><Sparkles className="h-4 w-4" /><span>Ask AI</span></button>
            </div>
            <div className="flex items-center gap-1 border-l border-line pl-2">
              {canEdit(selectedPage) && (
                <button
                  onClick={() => setPreviewMode((value) => !value)}
                  className={`rounded-md p-2 ${previewMode ? 'bg-accent-subtle text-accent-text' : 'text-muted hover:bg-surface-hover'}`}
                  title={previewMode ? 'Back to editing' : 'Preview rendered note'} aria-label={previewMode ? 'Back to editing' : 'Preview rendered note'}
                >
                  {previewMode ? <Pencil className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              )}
              <SaveIndicator state={saveState} />
              {canEdit(selectedPage) && <button onClick={() => void savePage({ manual: true })} className="rounded-md p-2 text-muted hover:bg-surface-hover hover:text-accent-text" title="Save version" aria-label="Save version"><Save className="h-4 w-4" /></button>}
              <button onClick={() => { setActivePanel(null); setSplitOpen((open) => !open); }} className={`rounded-md p-2 ${splitOpen ? 'bg-accent-subtle text-accent-text' : 'text-muted hover:bg-surface-hover'}`} title="Split study view" aria-label="Split study view"><SplitSquareHorizontal className="h-4 w-4" /></button>
              <button onClick={() => openPanel('comments')} className="rounded-md p-2 text-muted hover:bg-surface-hover" title="Comments" aria-label="Comments"><MessageSquare className="h-4 w-4" /></button>
              <button onClick={() => openPanel('share')} className="rounded-md p-2 text-muted hover:bg-surface-hover" title="Share" aria-label="Share"><Share2 className="h-4 w-4" /></button>
              <button onClick={() => openPanel('history')} className="hidden rounded-md p-2 text-muted hover:bg-surface-hover sm:block" title="Version history" aria-label="Version history"><History className="h-4 w-4" /></button>
              <button onClick={() => openPanel('details')} className="rounded-md p-2 text-muted hover:bg-surface-hover" title="Page details" aria-label="Page details"><MoreVertical className="h-4 w-4" /></button>
            </div>
          </> : <><span className="font-semibold">Notebook workspace</span><span className="text-sm text-muted">Select a page to begin</span></>}
        </header>

        {selectedPage && (draftRecovery || conflictPage || saveState === 'offline') && (
          <div className={`flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm ${conflictPage ? 'border-danger-border bg-danger-subtle text-danger' : 'border-warning-border bg-warning-subtle text-warning'}`}>
            {draftRecovery ? <>
              <FileClock className="h-4 w-4" /><span className="flex-1">A local draft is available for this page.</span>
              <button onClick={recoverDraft} className="banner-button">Recover</button><button onClick={discardDraft} className="banner-button">Discard</button>
            </> : conflictPage ? <>
              <RefreshCw className="h-4 w-4" /><span className="flex-1">Another edit was saved first. Keep your draft or load revision {conflictPage.revision}.</span>
              <button onClick={() => void savePage({ manual: true, force: true })} className="banner-button">Overwrite</button><button onClick={loadServerConflict} className="banner-button">Load server copy</button>
            </> : <><CloudOff className="h-4 w-4" /><span>Your draft is stored locally and will save when the connection returns.</span></>}
          </div>
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {openingPage ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Opening page</div>
          ) : selectedPage ? <>
            <main className={`${splitOpen ? 'hidden lg:flex' : 'flex'} min-w-0 flex-1 flex-col overflow-hidden`}>
              <div className="flex items-center gap-2 overflow-x-auto border-b border-subtle px-4 py-2 xl:hidden">
                <button onClick={() => void addReview()} className="toolbar-command"><RefreshCw className="h-4 w-4" /> Review</button>
                <button onClick={() => void addStudyTask()} className="toolbar-command"><Zap className="h-4 w-4" /> Task</button>
                {canEdit(selectedPage) && <button onClick={() => setShowDrawing(true)} className="toolbar-command"><PenTool className="h-4 w-4" /> Draw</button>}
                <button onClick={() => openAI(false)} className="toolbar-command"><Sparkles className="h-4 w-4" /> AI</button>
              </div>
              <div className="flex-1 overflow-y-auto bg-surface-raised p-3 sm:p-5">
                <div className="mx-auto max-w-5xl">
                  {canEdit(selectedPage) && !previewMode ? (
                    <RichTextEditor
                      key={selectedPage.id}
                      content={editContent}
                      onChange={(content) => { setEditContent(content); setDirty(true); postTyping(true); }}
                      onSelectionChange={setSelectedText}
                      onCursorChange={(from, to) => postCursor(from, to)}
                      remoteCursors={remoteCursors}
                      insertRequest={insertRequest}
                      compactToolbar
                      placeholder="e.g. Key terms, worked examples, diagrams, and revision reminders"
                      yjsPageId={selectedPage.id}
                      yjsRemoteUpdate={yjsRemoteUpdate}
                    />
                  ) : (
                    <div className="min-h-[440px] rounded-md border border-line bg-surface p-6">
                      <div className="mb-4 text-xs font-semibold uppercase text-muted">
                        {canEdit(selectedPage) ? 'Preview' : 'Shared read-only page'}
                      </div>
                      {editContent ? <RichContent html={editContent} /> : <p className="text-muted">This page is empty.</p>}
                    </div>
                  )}
                </div>
              </div>
              <footer className="flex min-h-9 items-center gap-3 border-t border-line bg-surface px-4 text-xs text-muted">
                <span>Revision {selectedPage.revision}</span>
                <span>{stripHtml(editContent).split(/\s+/).filter(Boolean).length} words</span>
                {selectedText && <span className="truncate text-accent-text">Selection: {selectedText}</span>}
                <div className="ml-auto flex -space-x-1.5">
                  {effectivePresence.slice(0, 5).map((item) => <div key={item.user.id} title={item.user.name || item.user.email} className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-accent text-[9px] font-bold text-accent-fg">{initials(item.user)}</div>)}
                </div>
              </footer>
            </main>

            {splitOpen && (
              <aside className="flex w-full flex-col border-l border-line bg-surface lg:w-[44%] lg:min-w-[360px]">
                <div className="flex h-12 items-center gap-2 border-b border-line px-3">
                  <SplitSquareHorizontal className="h-4 w-4 text-accent-text" /><span className="text-sm font-semibold">Study question</span>
                  <button onClick={() => setSplitOpen(false)} className="ml-auto rounded-sm p-1.5 text-muted hover:bg-surface-hover" title="Close split view" aria-label="Close split view"><PanelRightClose className="h-4 w-4" /></button>
                </div>
                <div className="border-b border-line p-3">
                  <div className="relative"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted" /><input value={questionSearch} onChange={(event) => { const value = event.target.value; setQuestionSearch(value); setQuestionResults([]); setQuestionSearchError(null); setQuestionSearchAttempted(false); setQuestionSearching(value.trim().length >= 2); }} placeholder="e.g. inheritance, 0610-S25-P21-Q2, or plant nutrition" className="h-9 w-full rounded-md border border-strong bg-surface pl-8 pr-9 text-sm outline-none focus:border-accent" />{questionSearching && <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted" />}</div>
                  {questionSearchError && <p className="mt-2 text-xs text-danger" role="alert">{questionSearchError}</p>}
                  {questionResults.length > 0 && <div className="mt-2 max-h-48 overflow-y-auto rounded-md border border-line bg-surface p-1">{questionResults.map((result) => <button key={result.id} onClick={() => { void loadQuestion(Number(result.id.replace('question-', ''))); setQuestionResults([]); setQuestionSearch(''); }} className="block w-full rounded-sm px-2 py-2 text-left hover:bg-surface-hover"><span className="block truncate text-xs font-semibold">{result.title}</span><span className="mt-0.5 block line-clamp-2 text-xs text-muted">{result.snippet}</span></button>)}</div>}
                  {questionSearch.trim().length >= 2 && questionSearchAttempted && !questionSearchError && questionResults.length === 0 && <p className="mt-2 text-xs text-muted">No matching questions found.</p>}
                </div>
                <div className="flex-1 overflow-y-auto p-4">
                  {questionLoading ? <div className="flex justify-center py-16 text-sm text-muted"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading question</div> : question ? <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2"><h3 className="font-mono text-sm font-bold">{questionCode(question)}</h3><span className="rounded-sm bg-surface-raised px-2 py-1 text-xs">{question.marks} marks</span></div>
                    <div className="text-xs text-muted">{question.subject_name} · {question.topic}</div>
                    <div className="rounded-md border border-line bg-surface-raised p-4"><FormattedMessage content={question.content} /></div>
                    {question.images?.map((imagePath, index) => <div key={imagePath} className="rounded-md border border-line bg-surface p-2"><Image src={imagePath} alt={`Question figure ${index + 1}`} width={1000} height={700} unoptimized className="mx-auto h-auto max-h-80 max-w-full object-contain" /></div>)}
                    <div className="flex flex-wrap gap-2">
                      {canEdit(selectedPage) && <button onClick={insertQuestionIntoNote} className="primary-command"><FolderInput className="h-4 w-4" /> Insert into note</button>}
                      {markscheme && <button onClick={() => setShowMarkscheme((show) => !show)} className="secondary-command">{showMarkscheme ? 'Hide' : 'Show'} mark scheme</button>}
                    </div>
                    {showMarkscheme && markscheme && <div className="rounded-md border border-warning-border bg-warning-subtle p-4"><h4 className="mb-2 text-xs font-bold uppercase text-warning">Mark scheme</h4><FormattedMessage content={markscheme.content} /></div>}
                  </div> : <div className="px-8 py-16 text-center text-muted"><Search className="mx-auto mb-3 h-8 w-8 opacity-50" /><p className="text-sm font-medium">Find a past-paper question to study beside your notes.</p></div>}
                </div>
              </aside>
            )}

            {activePanel && (
              <aside className="absolute inset-0 z-30 flex flex-col border-l border-line bg-surface sm:left-auto sm:w-[360px] lg:static">
                <div className="flex h-14 items-center gap-2 border-b border-line px-4">
                  <h3 className="text-sm font-semibold capitalize">{activePanel === 'share' ? 'Share and presence' : activePanel}</h3>
                  <button onClick={() => setActivePanel(null)} className="ml-auto rounded-sm p-1.5 text-muted hover:bg-surface-hover"><X className="h-4 w-4" /></button>
                </div>
                <div className="flex-1 overflow-y-auto p-4">
                  {panelLoading && activePanel !== 'details' ? <div className="flex justify-center py-12 text-sm text-muted"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading</div> : null}
                  {activePanel === 'details' && <div className="space-y-5">
                    <label className="block"><span className="field-label">Page icon</span><input value={selectedPage.icon} maxLength={16} disabled={!canEdit(selectedPage)} onChange={(event) => { const value = event.target.value; setSelectedPage((page) => page ? { ...page, icon: value } : page); }} onBlur={(event) => void patchMetadata({ icon: event.target.value })} className="field-input" placeholder="e.g. Bio, M1, Ch4" /></label>
                    <label className="block"><span className="field-label">Tags</span><input value={tagInput} disabled={!canEdit(selectedPage)} onChange={(event) => setTagInput(event.target.value)} onBlur={() => void patchMetadata({ tags: tagInput.split(',').map((tag) => tag.trim()).filter(Boolean) })} className="field-input" placeholder="e.g. biology, revision, cells" /></label>
                    <div className="flex flex-wrap gap-2">{selectedPage.tags.map((tag) => <span key={tag} className="rounded-sm bg-surface-raised px-2 py-1 text-xs text-secondary"><Tags className="mr-1 inline h-3 w-3" />{tag}</span>)}</div>
                    {selectedPage.accessRole === 'owner' && <label className="block"><span className="field-label">Move to section</span><select value={selectedPage.sectionId} onChange={(event) => void movePageToSection(event.target.value)} className="field-input">{editableSections.map((section) => <option key={section.id} value={section.id}>{section.notebookName} / {section.name}</option>)}</select></label>}
                    <div className="space-y-2 border-t border-line pt-4">
                      <button onClick={() => void patchMetadata({ favorite: !selectedPage.favorite })} disabled={!canEdit(selectedPage)} className="panel-action"><Star className={`h-4 w-4 ${selectedPage.favorite ? 'fill-warning text-warning' : ''}`} /> {selectedPage.favorite ? 'Remove from favorites' : 'Add to favorites'}</button>
                      {selectedPage.accessRole === 'owner' && <button onClick={() => void patchMetadata({ archived: !selectedPage.archived })} className="panel-action">{selectedPage.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />} {selectedPage.archived ? 'Restore page' : 'Archive page'}</button>}
                      <button onClick={() => void duplicatePage(selectedPage.id)} className="panel-action"><Copy className="h-4 w-4" /> Duplicate page</button>
                    </div>
                    <div className="border-t border-line pt-4 text-xs text-muted"><p>Revision {selectedPage.revision}</p><p className="mt-1">Updated {formatDate(selectedPage.updatedAt)}</p><p className="mt-1 capitalize">Access: {selectedPage.accessRole || 'owner'}</p></div>
                  </div>}
                  {activePanel === 'history' && !panelLoading && <div className="space-y-2">{snapshots.map((snapshot) => <div key={snapshot.id} className="rounded-md border border-line p-3"><div className="flex items-start gap-2"><FileClock className="mt-0.5 h-4 w-4 text-muted" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{snapshot.title}</p><p className="mt-1 text-xs text-muted">Revision {snapshot.revision} · {snapshot.reason} · {formatDate(snapshot.createdAt)}</p>{snapshot.createdBy && <p className="mt-1 text-xs text-muted">{snapshot.createdBy.name || snapshot.createdBy.email}</p>}</div>{canEdit(selectedPage) && <button onClick={() => void restoreSnapshot(snapshot.id)} className="rounded-sm p-1.5 text-muted hover:bg-surface-hover" title="Restore version" aria-label="Restore version"><RefreshCw className="h-4 w-4" /></button>}</div></div>)}{snapshots.length === 0 && <p className="py-10 text-center text-sm text-muted">Versions appear after autosaves and manual saves.</p>}</div>}
                  {activePanel === 'comments' && !panelLoading && <div className="space-y-4">
                    <div><textarea value={commentText} onChange={(event) => setCommentText(event.target.value)} className="field-input min-h-20 resize-y" placeholder={selectedText ? 'Add a question or correction for the selected text' : 'Add a page-level question, correction, or reminder'} />{selectedText && <p className="mt-1 line-clamp-2 text-xs text-accent-text">Attached to: “{selectedText}”</p>}<button onClick={() => void addComment()} disabled={!commentText.trim()} className="primary-command mt-2"><MessageSquare className="h-4 w-4" /> Comment</button></div>
                    <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={includeResolved} onChange={(event) => setIncludeResolved(event.target.checked)} /> Show resolved</label>
                    {comments.map((comment) => <div key={comment.id} className={`rounded-md border p-3 ${comment.resolved ? 'border-line opacity-60' : 'border-line'}`}><div className="flex items-center gap-2"><div className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-inverse text-[9px] font-bold text-inverse">{initials(comment.user)}</div><span className="truncate text-xs font-semibold">{comment.user.name || comment.user.email}</span><span className="ml-auto text-[10px] text-muted">{formatDate(comment.createdAt)}</span></div>{comment.anchor && <blockquote className="mt-2 border-l-2 border-accent pl-2 text-xs text-muted">{comment.anchor}</blockquote>}<p className="mt-2 whitespace-pre-wrap text-sm">{comment.content}</p><button onClick={() => void resolveComment(comment)} className="mt-2 text-xs font-medium text-accent-text hover:underline">{comment.resolved ? 'Reopen' : 'Resolve'}</button></div>)}
                  </div>}
                  {activePanel === 'share' && !panelLoading && <div className="space-y-5">
                    <div><p className="field-label">Active now</p><div className="mt-2 flex flex-wrap gap-2">{effectivePresence.map((item) => <div key={item.user.id} className="flex items-center gap-2 rounded-md bg-surface-raised px-2 py-1.5 text-xs"><span className="h-2 w-2 rounded-full bg-accent" />{item.user.name || item.user.email}</div>)}</div></div>
                    {selectedPage.accessRole === 'owner' && <div className="border-y border-line py-4"><p className="field-label">Invite collaborator</p><input type="email" value={shareEmail} onChange={(event) => setShareEmail(event.target.value)} className="field-input mt-2" placeholder="student@example.com" /><div className="mt-2 flex gap-2"><select value={shareRole} onChange={(event) => setShareRole(event.target.value as 'editor' | 'viewer')} className="field-input flex-1"><option value="editor">Can edit</option><option value="viewer">Can view</option></select><button onClick={() => void inviteCollaborator()} disabled={!shareEmail.trim()} className="primary-command"><UserPlus className="h-4 w-4" /> Invite</button></div></div>}
                    {owner && <PersonRow person={owner} label="Owner" />}
                    <div className="space-y-2">{collaborators.map((collaborator) => <div key={collaborator.id} className="flex items-center gap-3 rounded-md border border-line p-2"><PersonAvatar person={collaborator.user} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{collaborator.user.name || collaborator.user.email}</p><p className="text-xs capitalize text-muted">{collaborator.role}</p></div>{selectedPage.accessRole === 'owner' && <button onClick={() => void removeCollaborator(collaborator.userId)} className="rounded-sm p-1.5 text-muted hover:bg-danger-subtle hover:text-danger"><X className="h-4 w-4" /></button>}</div>)}</div>
                  </div>}
                </div>
              </aside>
            )}
          </> : (
            <div className="flex flex-1 items-center justify-center bg-surface-raised p-8 text-center"><div className="max-w-sm"><div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-md border border-line bg-surface"><FileText className="h-7 w-7 text-accent-text" /></div><h2 className="text-lg font-semibold">Choose a note page</h2><p className="mt-2 text-sm text-muted">Search, browse a notebook, or create a page from the navigation panel.</p><button onClick={() => setSidebarOpen(true)} className="primary-command mx-auto mt-4 lg:hidden"><Menu className="h-4 w-4" /> Open notes</button></div></div>
          )}
        </div>
      </section>

      {showDrawing && selectedPage && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
          onClick={() => { if (!drawingUploading) setShowDrawing(false); }}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-md bg-surface shadow-overlay"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <PenTool className="h-4 w-4 text-accent-text" />
              <h3 className="text-sm font-semibold">Drawing</h3>
              <button
                onClick={() => setShowDrawing(false)}
                disabled={drawingUploading}
                className="ml-auto rounded-sm p-1.5 text-muted hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                title="Close" aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div ref={drawingFrameRef} className="relative flex-1 overflow-auto p-4">
              {drawingWidth !== null && (
              <DrawingCanvas
                ref={drawingCanvasRef}
                width={drawingWidth}
                height={DRAWING_CANVAS_HEIGHT}
                onSave={(dataUrl) => {
                  if (drawingUploading) return;
                  if (drawingCanvasRef.current?.isEmpty()) {
                    notify('Draw something first');
                    return;
                  }
                  void insertDrawingIntoNote(dataUrl);
                }}
              />
              )}
              {drawingUploading && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm font-medium text-secondary backdrop-blur-sm dark:bg-gray-900/70">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Uploading drawing
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {commandOpen && (
        <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onClick={() => setCommandOpen(false)}>
          <div className="w-full max-w-xl overflow-hidden rounded-md border border-line bg-surface shadow-overlay" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center gap-2 border-b border-line px-3"><Search className="h-5 w-5 text-muted" /><input autoFocus value={commandQuery} onChange={(event) => setCommandQuery(event.target.value)} placeholder="e.g. Biology, Cell transport, or Mock exam notes" className="h-12 flex-1 bg-transparent text-sm outline-none" /><button onClick={() => setCommandOpen(false)} className="rounded-sm border border-line px-2 py-1 text-xs text-muted">Esc</button></div>
            <div className="max-h-[55vh] overflow-y-auto p-2">{flatResults.map((location) => <button key={location.page.id} onClick={() => { setCommandOpen(false); void openPage(location.page.id); }} className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-surface-hover"><span>{location.page.icon || '📝'}</span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{location.page.title}</span><span className="block truncate text-xs text-muted">{location.notebook.name} / {location.section.name}</span></span></button>)}{flatResults.length === 0 && <p className="py-10 text-center text-sm text-muted">No pages found</p>}</div>
          </div>
        </div>
      )}

      {creating && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={() => setCreating(null)}>
          <div className="w-full max-w-sm rounded-md bg-surface p-5 shadow-overlay" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center"><h3 className="font-semibold">New {creating.kind}</h3><button onClick={() => setCreating(null)} className="ml-auto rounded-sm p-1 text-muted hover:bg-surface-hover"><X className="h-4 w-4" /></button></div>
            <input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void handleCreate(); }} placeholder={`${creating.kind} name`} className="field-input mt-4" />
            <div className="mt-4 flex justify-end gap-2"><button onClick={() => setCreating(null)} className="secondary-command">Cancel</button><button onClick={() => void handleCreate()} disabled={!newName.trim() || submitting} className="primary-command">{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create</button></div>
          </div>
        </div>
      )}
      <style jsx global>{`
        .menu-row { display: flex; width: 100%; align-items: center; gap: .5rem; border-radius: .25rem; padding: .5rem; text-align: left; font-size: .75rem; }
        .menu-row:hover { background: rgb(243 244 246); }
        .dark .menu-row:hover { background: rgb(31 41 55); }
        .toolbar-command { display: inline-flex; height: 2rem; align-items: center; gap: .375rem; border-radius: .375rem; padding: 0 .5rem; font-size: .75rem; font-weight: 600; color: rgb(75 85 99); }
        .toolbar-command:hover { background: rgb(243 244 246); color: rgb(4 120 87); }
        .dark .toolbar-command { color: rgb(209 213 219); }
        .dark .toolbar-command:hover { background: rgb(31 41 55); color: rgb(110 231 183); }
        .primary-command { display: inline-flex; height: 2.25rem; align-items: center; justify-content: center; gap: .375rem; border-radius: .375rem; background: rgb(5 150 105); padding: 0 .75rem; font-size: .75rem; font-weight: 700; color: white; }
        .primary-command:hover { background: rgb(4 120 87); }
        .primary-command:disabled { cursor: not-allowed; opacity: .5; }
        .secondary-command { display: inline-flex; height: 2.25rem; align-items: center; justify-content: center; gap: .375rem; border-radius: .375rem; border: 1px solid rgb(209 213 219); background: white; padding: 0 .75rem; font-size: .75rem; font-weight: 600; color: rgb(55 65 81); }
        .dark .secondary-command { border-color: rgb(55 65 81); background: rgb(17 24 39); color: rgb(229 231 235); }
        .banner-button { border-radius: .25rem; border: 1px solid currentColor; padding: .25rem .5rem; font-size: .75rem; font-weight: 700; }
        .field-label { display: block; font-size: .75rem; font-weight: 700; color: rgb(75 85 99); }
        .dark .field-label { color: rgb(156 163 175); }
        .field-input { width: 100%; border-radius: .375rem; border: 1px solid rgb(209 213 219); background: white; padding: .5rem .625rem; font-size: .875rem; outline: none; }
        .field-input:focus { border-color: rgb(16 185 129); }
        .field-input:disabled { opacity: .6; }
        .dark .field-input { border-color: rgb(55 65 81); background: rgb(17 24 39); color: rgb(243 244 246); }
        .panel-action { display: flex; width: 100%; align-items: center; gap: .5rem; border-radius: .375rem; padding: .5rem; text-align: left; font-size: .875rem; }
        .panel-action:hover { background: rgb(243 244 246); }
        .dark .panel-action:hover { background: rgb(31 41 55); }
      `}</style>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'saving') return <span className="hidden items-center gap-1 text-xs text-muted sm:flex"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving</span>;
  if (state === 'offline') return <span className="hidden items-center gap-1 text-xs text-warning sm:flex"><CloudOff className="h-3.5 w-3.5" /> Offline</span>;
  if (state === 'conflict') return <span className="hidden items-center gap-1 text-xs text-danger sm:flex"><RefreshCw className="h-3.5 w-3.5" /> Conflict</span>;
  if (state === 'error') return <span className="hidden text-xs text-danger sm:block">Save failed</span>;
  if (state === 'saved') return <span className="hidden items-center gap-1 text-xs text-accent-text sm:flex"><Check className="h-3.5 w-3.5" /> Saved</span>;
  return null;
}

function PersonAvatar({ person }: { person: Person }) {
  return <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-accent-fg">{initials(person)}</div>;
}

function PersonRow({ person, label }: { person: Person; label: string }) {
  return <div className="flex items-center gap-3 rounded-md border border-line p-2"><PersonAvatar person={person} /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{person.name || person.email}</p><p className="text-xs text-muted">{label}</p></div></div>;
}
