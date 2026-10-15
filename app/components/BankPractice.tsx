'use client';

/* eslint-disable @next/next/no-img-element */

/**
 * The Practice tab, sourced from the crop-first question bank.
 *
 * Students see the question as it was printed: a stack of image strips cut
 * from the original paper, with the answer space and page furniture removed.
 * That is deliberate. A transcription of a physics question is a lossy copy of
 * it — diagrams, tables, graphs and notation are exactly what a past paper is
 * made of — so the crop is the faithful artefact and the text, where it
 * exists, serves the routes that reason about a question rather than show it.
 *
 * Which means most of what this component does is get out of the way of an
 * image. The one piece of real logic is the transcription gate: see
 * `AssistancePanel`.
 */
import { useEffect, useRef, useState } from 'react';
import PreviewNotice from './PreviewNotice';
import { useSession } from 'next-auth/react';
import { GraduationCap, Loader2, Search, Star } from 'lucide-react';
import BankQuestionCard from './BankQuestionView';
import FormattedMessage from './FormattedMessage';
import { useScreenContext } from './ScreenContext';
import type { BankQuestionView, BankStrip } from '@/lib/bank-questions';
import {
  EMPTY_MEMORY, memoryKey, parseMemory, serializeMemory, type PracticeFilterMemory,
} from '@/lib/practice-filter-memory';
import { PageHeader } from './ui';

type Filters = {
  subjects: Array<{ id: number; code: string; name: string }>;
  years: number[];
  sessions: string[];
  paperNumbers: number[];
  topics: string[];
};

type Summary = {
  id: number;
  rootNumber: number;
  totalMarks: number | null;
  hasText: boolean;
  hasMarkScheme: boolean;
  glimpse: { topics: string[]; commandTerms: string[]; difficulty: number | null };
  thumbnail: BankStrip | null;
  paper: {
    id: number;
    /** Display name, e.g. "Biology (IGCSE)". */
    subject: string;
    /** Syllabus code, e.g. "0610" -- what scoping wants. The server has always
     *  sent it; this type simply did not declare it, so the screen context
     *  reached for `subject` and told the tutor the course was "Biology
     *  (IGCSE)". */
    subjectCode: string;
    year: number;
    session: string;
    paperNumber: number;
    variant: number;
    /** Readable question code, e.g. "21M.1SL.TZ1.22" -- what the search box accepts. */
    code: string;
  };
};

type FullQuestion = BankQuestionView & { paper: Summary['paper'] };

const EMPTY_FILTERS: Filters = {
  subjects: [], years: [], sessions: [], paperNumbers: [], topics: [],
};

/** "s" and "w" are how the corpus stores it; neither is what to show. */
function sessionLabel(session: string): string {
  if (session === 's') return 'May/June';
  if (session === 'w') return 'Oct/Nov';
  if (session === 'm') return 'Feb/March';
  return session;
}

/** The tagging rubric's names, so the number means the same thing everywhere. */
const DIFFICULTY_NAMES = ['', 'Recall', 'Routine', 'Method selection', 'Synthesis', 'Extension'];

function hasGlimpse(glimpse: Summary['glimpse']): boolean {
  return glimpse.topics.length > 0 || glimpse.commandTerms.length > 0 || glimpse.difficulty !== null;
}

function paperLabel(paper: Summary['paper']): string {
  const variant = paper.variant ? `/${paper.variant}` : '';
  return `${paper.year} ${sessionLabel(paper.session)} · Paper ${paper.paperNumber}${variant}`;
}

/**
 * Hints and AI marking, when the question has been transcribed.
 *
 * These read the question, they do not display it, so they need its text and
 * cannot work from an image. The crop-only corpus run produced every published
 * question at no model cost and left `bodyMd` empty; transcription is a
 * separate paid pass that fills it in subject by subject.
 *
 * So the controls are hidden rather than shown-and-broken. Offering a hint
 * button that always fails teaches a student the feature is broken; showing
 * nothing, with one line saying why, is honest and leaves the page usable. As
 * transcription lands the controls appear for the questions that have it, with
 * no change here.
 */
function AssistancePanel({ question }: { question: FullQuestion }) {
  const [hints, setHints] = useState<Array<{ level: number; text: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!question.hasText) {
    // A keyed question *is* marked automatically -- against the stored answer
    // letter, which needs no transcript. Saying otherwise under a question that
    // just came back "Correct." reads as the app not knowing what it did.
    const keyed = Boolean(question.markScheme?.answerLetter);
    // "Not available yet" alone read as broken-and-coming-soon, sitting
    // directly beneath a self-marking widget that is in fact the intended
    // flow -- so the two messages undercut each other. Name the reason (this
    // question is stored as an image of the printed paper) and present marking
    // it yourself as the way it works, not as a consolation.
    return (
      <p className="px-4 py-3 text-xs text-muted">
        {keyed
          ? 'This question is stored as a scan of the printed paper, so hints aren\u2019t available for it. Your answer is still marked against the answer key.'
          : 'This question is stored as a scan of the printed paper, so it can\u2019t be marked automatically. Answer it, then mark yourself against the mark scheme below \u2014 that is how the bank is designed to be used.'}
      </p>
    );
  }

  const requestHint = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bankQuestionId: question.id,
          level: hints.length + 1,
          // So the next hint builds on these rather than restating them.
          previousHints: hints.map((hint) => hint.text),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not fetch a hint');
      setHints((current) => [...current, { level: current.length + 1, text: data.hint }]);
    } catch (hintError) {
      setError((hintError as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2 px-4 py-3">
      {hints.map((hint) => (
        // The model answers in markdown and LaTeX (bold, numbered steps,
        // \(T\cos\theta\)). Printed as a plain string, all of that showed as
        // raw punctuation and the steps ran together in one paragraph -- the
        // legacy browser renders the same hint through FormattedMessage.
        <div key={hint.level} className="rounded-md border border-warning-border bg-surface px-3 py-2">
          <p className="mb-1 text-[10px] font-bold uppercase text-warning">Hint {hint.level}</p>
          <div className="text-sm text-secondary">
            <FormattedMessage content={hint.text} />
          </div>
        </div>
      ))}
      {error && <p className="text-sm text-danger">{error}</p>}
      <button
        type="button"
        onClick={requestHint}
        disabled={loading || hints.length >= 3}
        className="inline-flex items-center gap-2 rounded-md border border-strong px-3 py-1.5 text-sm text-secondary hover:bg-surface-hover disabled:opacity-50"
      >
        {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {hints.length === 0 ? 'Get a hint' : hints.length >= 3 ? 'No more hints' : 'Another hint'}
      </button>
    </div>
  );
}

export default function BankPractice({
  initialQuestionId = null,
  initialSubjectCode = null,
  onSubjectApplied,
  onQuestionOpened,
}: {
  /**
   * Open straight onto this bank question, for a deep link from search.
   *
   * Search results used to carry `qid`, which routes to the legacy text-bank
   * browser -- a different table with an independent id space, so a result
   * opened an unrelated question or none at all. The bank needs its own entry
   * point rather than borrowing that one.
   */
  initialQuestionId?: number | null;
  /**
   * Open with this syllabus code ("0625") already chosen, for the course cards
   * on the dashboard. A code rather than the bank's own subject id because the
   * caller has the code and does not know the id -- that mapping lives in the
   * bank's filter list, which this component is already loading.
   */
  initialSubjectCode?: string | null;
  /** Fired once the code has been applied, so the caller can stop resending it. */
  onSubjectApplied?: () => void;
  onQuestionOpened?: () => void;
} = {}) {
  const { data: authSession, status: sessionStatus } = useSession();
  const userId = authSession?.user?.id ?? null;
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [subject, setSubject] = useState('');
  const [year, setYear] = useState('');
  const [session, setSession] = useState('');
  const [paperNumber, setPaperNumber] = useState('');
  const [page, setPage] = useState(1);
  /**
   * Whose subjects to browse.
   *
   * A student is enrolled in their own courses, so 'enrolled' is the useful
   * default -- but it is also a hard filter, and without a way out of it the
   * other 70 subjects in the bank are unreachable. Someone enrolled only in
   * IGCSE courses would conclude the bank has no IB or A Level papers at all,
   * when it holds tens of thousands.
   */
  const [scope, setScope] = useState<'enrolled' | 'all'>('enrolled');
  /**
   * The syllabus code a course card asked for, still waiting to be resolved
   * against the bank's subject list. A ref because the filter fetch reads it
   * and clearing it must not re-run that fetch.
   */
  const pendingSubjectCode = useRef(initialSubjectCode);
  const [topic, setTopic] = useState('');
  /** What is in the search box, and the trimmed value the list was last asked for. */
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  /** Why a search returned nothing, when the server can say (e.g. an SL code under an HL subject). */
  const [notice, setNotice] = useState<string | null>(null);
  /** Question ids whose Peek is open. Not remembered: it is a glance, not a setting. */
  const [peeking, setPeeking] = useState<Set<number>>(new Set());
  const [onlyBookmarked, setOnlyBookmarked] = useState(false);
  /** Ids the signed-in user has starred, so a list row can draw a filled star. */
  const [bookmarked, setBookmarked] = useState<Set<number>>(new Set());

  const [questions, setQuestions] = useState<Summary[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selected, setSelected] = useState<FullQuestion | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  /*
   * Filter memory. See lib/practice-filter-memory.ts for why it exists.
   *
   * `restored` gates every fetch below: restoring sets the subject, topic and
   * page in one go, and a request already in flight for the *default* filters
   * would resolve afterwards and, among other things, clear a restored topic
   * (the topic list is empty when no subject is chosen).
   */
  const [restored, setRestored] = useState(false);
  const restoreStarted = useRef(false);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  /** Latest list scroll offset. A ref: it changes on every scroll tick. */
  const scrollTopRef = useRef(0);
  /** A scroll offset waiting for the list to be on screen and loaded. */
  const pendingScrollRef = useRef<number | null>(null);
  const memoryRef = useRef<PracticeFilterMemory | null>(null);
  /** The account the memory was restored for; nothing is written under another. */
  const restoredUserRef = useRef<string | null>(null);

  useEffect(() => {
    // A second course card sends a different code; re-arm so the next filter
    // response applies it.
    if (initialSubjectCode) pendingSubjectCode.current = initialSubjectCode;
  }, [initialSubjectCode]);

  useEffect(() => {
    // Signed-out users simply have none; a 401 here is not an error worth
    // surfacing, it just means no stars are drawn.
    fetch('/api/bank/bookmarks')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && setBookmarked(new Set<number>(data.questionIds ?? [])))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    // Refetched when the subject changes, not only the scope: topics are
    // per-subject, so the list has to follow the selection. Without this the
    // control offered all 256 topics in the corpus whatever was on screen.
    if (!restored) return;
    // Ignore a response that a newer subject/scope has already superseded;
    // otherwise an old answer can land last and overwrite the topics list (and,
    // through the reset below, a topic that was just restored).
    let cancelled = false;
    const params = new URLSearchParams({ scope });
    if (subject) params.set('subject', subject);
    fetch(`/api/bank/questions?action=filters&${params}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || cancelled) return;
        setFilters({ ...EMPTY_FILTERS, ...data });
        // A topic chosen under the previous subject usually does not exist
        // under the new one, and leaving it set filters the list down to
        // nothing while the control still displays a plausible-looking choice.
        setTopic((current) => (current && !(data.topics ?? []).includes(current) ? '' : current));

        /*
         * Resolve a syllabus code handed in by a course card.
         *
         * The select is keyed on the bank's own subject id and the caller only
         * knows the code, so the translation needs this list. Done here rather
         * than in an effect watching `filters`, which would be a setState
         * cascading off another render.
         *
         * A code that is not in the list while scoped to the student's own
         * courses widens the scope once and resolves on the refetch -- that is
         * a link to a subject they are not enrolled in, and quietly showing
         * them the unfiltered bank would look like the link was ignored.
         */
        if (!pendingSubjectCode.current) return;
        const wanted = pendingSubjectCode.current;
        const match = (data.subjects ?? []).find(
          (option: Filters['subjects'][number]) =>
            option.code.toLowerCase() === wanted.toLowerCase(),
        );
        if (match) {
          pendingSubjectCode.current = null;
          setSubject(String(match.id));
          setPage(1);
          onSubjectApplied?.();
        } else if (scope === 'enrolled') {
          setScope('all');
        } else {
          // In neither scope: nothing to select, so stop trying.
          pendingSubjectCode.current = null;
          onSubjectApplied?.();
        }
      })
      .catch(() => {
        if (!cancelled) setFilters(EMPTY_FILTERS);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, subject, onSubjectApplied, restored]);


  useEffect(() => {
    // The bank needs a session, so there is nothing to ask for until we have
    // one. Fetching while `loading` would also fire a 401 on first paint for
    // every signed-in student, before the session resolves.
    if (sessionStatus !== 'authenticated' || !restored) return;

    // `stale` guards against responses arriving out of order. Changing two
    // filters quickly starts two requests, and the first one can answer last;
    // without this the older result overwrites the newer and the list stops
    // matching the controls above it.
    let stale = false;
    const controller = new AbortController();

    const params = new URLSearchParams({ page: String(page), limit: '20', scope });
    if (subject) params.set('subject', subject);
    if (year) params.set('year', year);
    if (session) params.set('session', session);
    if (paperNumber) params.set('paper', paperNumber);
    if (topic) params.set('topic', topic);
    // A search needs a subject; the box is disabled without one, and this keeps
    // a stale value from a restored session from reaching the server alone.
    if (search && subject) params.set('q', search);
    if (onlyBookmarked) params.set('bookmarked', '1');

    (async () => {
      try {
        const res = await fetch(`/api/bank/questions?${params}`, {
          signal: controller.signal,
        });
        const data = await res.json();
        if (stale) return;
        if (!res.ok) throw new Error(data?.error || 'Could not load questions');
        setQuestions(data.questions ?? []);
        setTotal(data.total ?? 0);
        setNotice(data.notice ?? null);
        setListError(null);
      } catch (error) {
        // An aborted request is this effect superseding itself, not a failure.
        if (stale || (error as Error).name === 'AbortError') return;
        setListError((error as Error).message);
        setQuestions([]);
      } finally {
        if (!stale) setListLoading(false);
      }
    })();

    return () => {
      stale = true;
      controller.abort();
    };
  }, [page, subject, year, session, paperNumber, scope, topic, search, onlyBookmarked, sessionStatus, restored]);

  // Typing searches 300 ms after the last keystroke. The guard against `search`
  // matters on restore: both start equal, and without it this would fire once
  // and put a restored page 3 back on page 1.
  useEffect(() => {
    if (!restored) return;
    const next = searchInput.trim();
    if (next === search) return;
    const timer = setTimeout(() => {
      setSearch(next);
      setPage(1);
      setSelected(null);
      setListLoading(true);
      scrollTopRef.current = 0;
      pendingScrollRef.current = null;
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, search, restored]);

  // Any filter change invalidates the current page number: page 7 of the old
  // result set is rarely page 7 of the new one, and is often past its end.
  const changeFilter = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPage(1);
    setSelected(null);
    setListLoading(true);
    scrollTopRef.current = 0;
    pendingScrollRef.current = null;
  };

  /**
   * Star or unstar, updating the set before the request returns.
   *
   * A star is a one-tap action on a list of images; waiting for a round trip
   * to fill it in reads as the tap not registering. If the request fails the
   * change is put back, so the UI never claims something the server rejected.
   */
  const toggleBookmark = async (id: number) => {
    const wasBookmarked = bookmarked.has(id);
    setBookmarked((current) => {
      const next = new Set(current);
      if (wasBookmarked) next.delete(id);
      else next.add(id);
      return next;
    });

    try {
      const res = wasBookmarked
        ? await fetch(`/api/bank/bookmarks?questionId=${id}`, { method: 'DELETE' })
        : await fetch('/api/bank/bookmarks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ questionId: id }),
          });
      if (!res.ok) throw new Error('rejected');
    } catch {
      setBookmarked((current) => {
        const next = new Set(current);
        if (wasBookmarked) next.add(id);
        else next.delete(id);
        return next;
      });
    }
  };

  const openQuestion = async (id: number) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/bank/questions?action=question&id=${id}`);
      const data = await res.json();
      if (res.ok) setSelected(data.question);
    } finally {
      setDetailLoading(false);
    }
  };

  /*
   * Restore on mount, once, as soon as the session says who is asking.
   *
   * A course card (`initialSubjectCode`) names a subject on purpose, so it wins
   * over anything remembered; a deep link (`initialQuestionId`) keeps the
   * remembered filters but not the remembered open question.
   */
  useEffect(() => {
    if (restoreStarted.current || sessionStatus === 'loading') return;
    restoreStarted.current = true;

    if (sessionStatus === 'authenticated' && userId) {
      restoredUserRef.current = userId;
      let saved: PracticeFilterMemory | null = null;
      try {
        saved = parseMemory(window.sessionStorage.getItem(memoryKey(userId)));
      } catch {
        // Storage can throw (blocked, private window); start from the defaults.
      }
      if (saved && !initialSubjectCode) {
        // sessionStorage is an external system that cannot be read during
        // render (it does not exist on the server), so this is the sync point.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setScope(saved.scope);
        setSubject(saved.subject);
        setYear(saved.year);
        setSession(saved.session);
        setPaperNumber(saved.paperNumber);
        setTopic(saved.topic);
        setSearchInput(saved.search);
        setSearch(saved.search);
        setOnlyBookmarked(saved.onlyBookmarked);
        setPage(saved.page);
        scrollTopRef.current = saved.scrollTop;
        pendingScrollRef.current = saved.scrollTop;
        if (saved.selectedId && !initialQuestionId) void openQuestion(saved.selectedId);
      }
    }
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once; guarded by restoreStarted
  }, [sessionStatus, userId]);

  const writeMemory = (memory: PracticeFilterMemory | null) => {
    if (!memory || !restoredUserRef.current) return;
    try {
      window.sessionStorage.setItem(
        memoryKey(restoredUserRef.current),
        serializeMemory({ ...memory, scrollTop: Math.round(scrollTopRef.current) }),
      );
    } catch {
      // Quota or blocked storage: remembering is a convenience, never an error.
    }
  };

  // Persist on every change of the remembered state.
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    memoryRef.current = restored
      ? {
          ...EMPTY_MEMORY,
          scope, subject, year, session, paperNumber, topic, search, onlyBookmarked, page, selectedId,
        }
      : null;
    writeMemory(memoryRef.current);
  }, [restored, scope, subject, year, session, paperNumber, topic, search, onlyBookmarked, page, selectedId]);

  // Scroll moves too often to be state, so flush the latest offset when the tab
  // is left (unmount) or the page is closed/hidden.
  useEffect(() => {
    const flush = () => writeMemory(memoryRef.current);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  // Put the list back where it was once it is on screen and has rows to scroll.
  useEffect(() => {
    const target = pendingScrollRef.current;
    if (target === null || selected || listLoading || questions.length === 0) return;
    const element = listScrollRef.current;
    if (!element) return;
    pendingScrollRef.current = null;
    element.scrollTop = target;
  }, [selected, listLoading, questions]);

  // Consume a deep link once the session exists: the detail fetch is
  // session-gated, so firing it before that 401s on first paint.
  const deepLinkRef = useRef<number | null>(null);
  useEffect(() => {
    if (sessionStatus !== 'authenticated') return;
    if (!initialQuestionId || deepLinkRef.current === initialQuestionId) return;
    deepLinkRef.current = initialQuestionId;
    void openQuestion(initialQuestionId);
    onQuestionOpened?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- openQuestion is recreated each render
  }, [initialQuestionId, sessionStatus]);

  // Tell the AI tutor which question is on screen.
  //
  // The tutor is mounted in `HomeShell` and reads `ScreenContext`, so without
  // this it knew only "Practice" -- the tab label -- while a student stared at
  // a specific past-paper question and asked "how do I do this one?". Three of
  // eight surfaces reported anything at all, and the bank, which is the corpus
  // students actually open, was not one of them.
  //
  // The id goes over rather than the wording: `BankQuestionView` carries
  // `hasText` and no `bodyMd`, so the client has never had the text to send.
  // `/api/ai/rag-chat` resolves it from the database instead.
  const { updateData } = useScreenContext();
  useEffect(() => {
    if (!selected) {
      updateData({
        bankQuestionId: undefined, bankPaperReference: undefined,
        bankCommandTerms: undefined, bankHasText: undefined,
      });
      return;
    }
    const paper = selected.paper;
    updateData({
      bankQuestionId: selected.id,
      // `subject` is the display name ("Biology (IGCSE)"); `subjectCode` is the
      // syllabus code ("0610"). The reference wants the readable one and
      // `subjectCode` wants the code -- passing the name for both is what made
      // the tutor ask "which course?" while looking at a Biology question,
      // because `pageSubjectCode` then matched no enrolled course at all.
      bankPaperReference: `${paper.subject} ${paper.year} ${paper.session} `
        + `Paper ${paper.paperNumber} Variant ${paper.variant} Q${selected.rootNumber}`,
      bankCommandTerms: selected.commandTerms?.length ? selected.commandTerms : undefined,
      bankHasText: selected.hasText,
      subjectCode: paper.subjectCode,
    });
  }, [selected, updateData]);

  const lastPage = Math.max(1, Math.ceil(total / 20));

  // Browsing the bank needs an account. Saying so beats the alternative, which
  // is the list error surfacing a bare "Sign in to browse the question bank."
  // where a student expected questions, with nothing to click.
  if (sessionStatus === 'unauthenticated') {
    return (
      <div className="h-full grid place-items-center p-6">
        <div className="max-w-md text-center">
          <GraduationCap className="w-10 h-10 mx-auto text-accent-text mb-4" aria-hidden="true" />
          <h2 className="text-xl font-bold text-primary">
            Sign in to practise
          </h2>
          <p className="text-sm text-secondary mt-2">
            The question bank is scoped to the subjects you study, and your attempts
            and bookmarks are saved to your account.
          </p>
          <a
            href="/auth/login"
            className="inline-flex mt-5 px-4 py-2.5 bg-accent text-white text-sm font-semibold rounded-md hover:bg-accent-hover"
          >
            Sign in
          </a>
        </div>
      </div>
    );
  }

  if (selected) {
    return (
      // The workspace that renders this is `flex-1 overflow-hidden`, so every
      // view has to supply its own scroll container. Without h-full and
      // overflow-y-auto the page is simply clipped at the fold and nothing
      // below the first screenful can be reached.
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-2 sm:p-4">
        <button
          type="button"
          onClick={() => {
            pendingScrollRef.current = scrollTopRef.current;
            setSelected(null);
          }}
          className="text-sm text-accent-text hover:underline"
        >
          ← Back to questions
        </button>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-secondary">
            {selected.paper.subject} · {paperLabel(selected.paper)}
            <span className="ml-2 font-mono text-xs text-muted">{selected.paper.code}</span>
          </p>
          <button
            type="button"
            onClick={() => toggleBookmark(selected.id)}
            aria-pressed={bookmarked.has(selected.id)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-strong px-2.5 py-1 text-xs text-secondary hover:bg-surface-hover"
          >
            <Star
              className={`h-3.5 w-3.5 ${
                bookmarked.has(selected.id) ? 'fill-warning text-warning' : ''
              }`}
              aria-hidden="true"
            />
            {bookmarked.has(selected.id) ? 'Starred' : 'Star'}
          </button>
        </div>
        <BankQuestionCard question={selected} />
          <div className="rounded-lg border border-line bg-surface">
            <AssistancePanel question={selected} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={listScrollRef}
      onScroll={(event) => {
        scrollTopRef.current = event.currentTarget.scrollTop;
      }}
      className="h-full overflow-y-auto"
    >
      <div className="mx-auto max-w-5xl space-y-4 p-2 sm:p-4">
      {/* The sidebar badges Practice as "Preview" and every other entrance to
          the bank carries the matching banner -- /bank, /bank/papers/[id] and
          the legacy QuestionsDatabase. This component had none, and it is the
          default body of the tab, so the one surface students actually open
          was the one that never explained itself. The banner text is also
          where self-marking is described, which is why meeting it cold made
          the intended flow read as a broken AI feature. */}
      {/* This is the default body of the Practice tab, so it owns the page
          title. It had none: the shell bar used to label every tab, which hid
          the gap here and in the notebook half of Materials. */}
      <PageHeader className="mb-0" title="Practice" />
      <PreviewNotice feature="question-bank" />
      <div className="inline-flex rounded-md bg-surface-raised p-0.5">
        {(['enrolled', 'all'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={scope === option}
            onClick={() => {
              // Changing scope changes which subjects exist, so a subject
              // chosen under the old one may not be in the new list.
              setScope(option);
              setSubject('');
              setSearchInput('');
              setSearch('');
              setPage(1);
              setSelected(null);
              setListLoading(true);
            }}
            className={`rounded-md px-3 py-1.5 text-xs font-medium ${
              scope === option
                ? 'bg-surface text-primary'
                : 'text-secondary'
            }`}
          >
            {option === 'enrolled' ? 'My courses' : 'All subjects'}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={onlyBookmarked}
          onClick={() => {
            setOnlyBookmarked((current) => !current);
            setPage(1);
            setSelected(null);
            setListLoading(true);
          }}
          className={`ml-1 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${
            onlyBookmarked
              ? 'bg-surface text-primary'
              : 'text-secondary'
          }`}
        >
          <Star
            className={`h-3.5 w-3.5 ${onlyBookmarked ? 'fill-warning text-warning' : ''}`}
            aria-hidden="true"
          />
          Starred
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <select
          aria-label="Subject"
          value={subject}
          onChange={(e) => {
            // A code only means something inside a subject, so choosing "All
            // subjects" drops the search with it.
            if (!e.target.value) {
              setSearchInput('');
              setSearch('');
            }
            changeFilter(setSubject)(e.target.value);
          }}
          className="rounded-md border border-strong px-2 py-1.5 text-sm bg-surface"
        >
          <option value="">All subjects</option>
          {filters.subjects.map((option) => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </select>
        <select
          aria-label="Year"
          value={year}
          onChange={(e) => changeFilter(setYear)(e.target.value)}
          className="rounded-md border border-strong px-2 py-1.5 text-sm bg-surface"
        >
          <option value="">All years</option>
          {filters.years.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
        <select
          aria-label="Session"
          value={session}
          onChange={(e) => changeFilter(setSession)(e.target.value)}
          className="rounded-md border border-strong px-2 py-1.5 text-sm bg-surface"
        >
          <option value="">All sessions</option>
          {filters.sessions.map((option) => (
            <option key={option} value={option}>{sessionLabel(option)}</option>
          ))}
        </select>
        <select
          aria-label="Paper"
          value={paperNumber}
          onChange={(e) => changeFilter(setPaperNumber)(e.target.value)}
          className="rounded-md border border-strong px-2 py-1.5 text-sm bg-surface"
        >
          <option value="">All papers</option>
          {filters.paperNumbers.map((option) => (
            <option key={option} value={option}>Paper {option}</option>
          ))}
        </select>
        {/* Topics belong to a subject, so the control only appears once one is
          * chosen -- offering the union across every subject listed topics that
          * could not match a single question on screen. Still gated on the list
          * being non-empty as well, because tagging is part of the model pass a
          * crop-only run skips and some subjects have no topics yet. */}
        {subject && filters.topics.length > 0 && (
          <select
            aria-label="Topic"
            value={topic}
            onChange={(e) => changeFilter(setTopic)(e.target.value)}
            className="col-span-2 rounded-md border border-strong px-2 py-1.5 text-sm bg-surface sm:col-span-4"
          >
            <option value="">All topics</option>
            {filters.topics.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        )}
      </div>

      <label className="relative block">
        <span className="sr-only">Search by question number or keyword</span>
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
          aria-hidden="true"
        />
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          disabled={!subject}
          maxLength={200}
          placeholder={
            subject
              ? 'Question number or keyword, e.g. 21M.1SL.TZ1.22, Q22, momentum'
              : 'Choose a subject to search by question number'
          }
          className="w-full rounded-md border border-strong bg-surface py-1.5 pl-8 pr-2 text-sm disabled:opacity-60"
        />
      </label>

      <p className="text-xs text-muted">
        {listLoading ? 'Loading…' : `${total.toLocaleString()} questions`}
      </p>

      {listError && (
        <p className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger">
          {listError}
        </p>
      )}

      {!listLoading && questions.length === 0 && !listError && (
        <div className="flex flex-col items-center gap-2 py-12 text-muted">
          <Search className="h-6 w-6" aria-hidden="true" />
          <p className="max-w-md text-center text-sm">
            {notice ?? (search ? `No questions match "${search}" with those filters.` : 'No questions match those filters.')}
          </p>
        </div>
      )}

      {/*
        * One surface with divided rows, not a stack of bordered cards. Twenty
        * questions each carrying their own border, radius and background is
        * the pattern CardRow was written to end -- "most of why the dashboard
        * read as a pile of boxes". This is a real ul/li, and CardRow is a
        * div, so the rows take its treatment directly rather than losing the
        * list semantics to use the component.
        */}
      <ul className="overflow-hidden rounded-lg border border-line bg-surface">
        {questions.map((question) => (
          <li
            key={question.id}
            // The star is its own control, so the row cannot be one big
            // button -- a button inside a button is invalid and the inner one
            // stops responding. The row is a container; the open action and
            // the star are siblings inside it.
            className="border-b border-subtle last:border-0 transition-colors hover:bg-surface-hover"
          >
            <div className="flex items-center">
            <button
              type="button"
              onClick={() => openQuestion(question.id)}
              disabled={detailLoading}
              className="flex min-w-0 flex-1 items-center gap-3 p-3 text-left disabled:opacity-60"
            >
              {question.thumbnail && (
                // Decorative: the text beside it already names the question.
                <img
                  src={question.thumbnail.url}
                  alt=""
                  className="hidden h-16 w-28 shrink-0 rounded-sm border border-line object-cover object-top sm:block"
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-primary">
                  Question {question.rootNumber}
                  {question.totalMarks !== null && (
                    <span className="ml-2 text-xs font-normal text-muted">
                      {question.totalMarks} marks
                    </span>
                  )}
                </span>
                <span className="block truncate text-xs text-muted">
                  {question.paper.subject} · {paperLabel(question.paper)}
                </span>
                <span className="block truncate font-mono text-[11px] text-muted">
                  {question.paper.code}
                </span>
              </span>
              {question.hasMarkScheme && (
                <span className="shrink-0 rounded-full bg-accent-subtle px-2 py-0.5 text-[11px] text-accent-text">
                  Mark scheme
                </span>
              )}
            </button>
            {hasGlimpse(question.glimpse) && (
              <button
                type="button"
                onClick={() =>
                  setPeeking((current) => {
                    const next = new Set(current);
                    if (next.has(question.id)) next.delete(question.id);
                    else next.add(question.id);
                    return next;
                  })
                }
                aria-expanded={peeking.has(question.id)}
                aria-controls={`peek-${question.id}`}
                aria-label={`Peek at question ${question.rootNumber}`}
                className="shrink-0 self-stretch px-2 text-xs text-accent-text hover:underline"
              >
                {peeking.has(question.id) ? 'Hide' : 'Peek'}
              </button>
            )}
            <button
              type="button"
              onClick={() => toggleBookmark(question.id)}
              aria-pressed={bookmarked.has(question.id)}
              aria-label={
                bookmarked.has(question.id)
                  ? `Remove star from question ${question.rootNumber}`
                  : `Star question ${question.rootNumber}`
              }
              className="shrink-0 self-stretch px-3 text-muted hover:text-warning"
            >
              <Star
                className={`h-4 w-4 ${
                  bookmarked.has(question.id) ? 'fill-warning text-warning' : ''
                }`}
                aria-hidden="true"
              />
            </button>
            </div>
            {peeking.has(question.id) && (
              // Text only: nothing here loads an image, so skimming twenty rows costs nothing.
              <dl
                id={`peek-${question.id}`}
                className="grid gap-x-4 gap-y-1.5 px-3 pb-3 text-xs sm:grid-cols-[auto_1fr]"
              >
                {question.glimpse.topics.length > 0 && (
                  <>
                    <dt className="text-muted">Covers</dt>
                    <dd className="flex flex-wrap gap-1">
                      {question.glimpse.topics.map((name) => (
                        <span key={name} className="rounded-full bg-accent-subtle px-2 py-0.5 text-accent-text">
                          {name}
                        </span>
                      ))}
                    </dd>
                  </>
                )}
                {question.glimpse.commandTerms.length > 0 && (
                  <>
                    <dt className="text-muted">Asks you to</dt>
                    <dd className="text-primary">{question.glimpse.commandTerms.join(', ')}</dd>
                  </>
                )}
                {question.glimpse.difficulty !== null && (
                  <>
                    <dt className="text-muted">Level</dt>
                    <dd className="text-primary">
                      {question.glimpse.difficulty}/5 · {DIFFICULTY_NAMES[question.glimpse.difficulty] ?? ''}
                      {question.totalMarks !== null ? ` · ${question.totalMarks} marks` : ''}
                    </dd>
                  </>
                )}
              </dl>
            )}
          </li>
        ))}
      </ul>

      {total > 20 && (
        <div className="flex items-center justify-between gap-2 pt-2">
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page <= 1 || listLoading}
            className="rounded-md border border-strong px-3 py-1.5 text-sm disabled:opacity-40"
          >
            Previous
          </button>
          <span className="text-xs tabular-nums text-muted">
            Page {page} of {lastPage.toLocaleString()}
          </span>
          <button
            type="button"
            onClick={() => setPage((current) => Math.min(lastPage, current + 1))}
            disabled={page >= lastPage || listLoading}
            className="rounded-md border border-strong px-3 py-1.5 text-sm disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
      </div>
    </div>
  );
}
