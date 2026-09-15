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
import type { BankQuestionView, BankStrip } from '@/lib/bank-questions';
import { commandTermLabel } from '@/lib/command-terms';

type Filters = {
  subjects: Array<{ id: number; code: string; name: string }>;
  years: number[];
  sessions: string[];
  paperNumbers: number[];
  topics: string[];
  commandTerms: string[];
};

type Summary = {
  id: number;
  rootNumber: number;
  totalMarks: number | null;
  hasText: boolean;
  hasMarkScheme: boolean;
  thumbnail: BankStrip | null;
  paper: {
    id: number;
    subject: string;
    year: number;
    session: string;
    paperNumber: number;
    variant: number;
  };
};

type FullQuestion = BankQuestionView & { paper: Summary['paper'] };

const EMPTY_FILTERS: Filters = {
  subjects: [], years: [], sessions: [], paperNumbers: [], topics: [], commandTerms: [],
};

/** "s" and "w" are how the corpus stores it; neither is what to show. */
function sessionLabel(session: string): string {
  if (session === 's') return 'May/June';
  if (session === 'w') return 'Oct/Nov';
  if (session === 'm') return 'Feb/March';
  return session;
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
        body: JSON.stringify({ bankQuestionId: question.id, level: hints.length + 1 }),
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
        <p key={hint.level} className="text-sm text-secondary">
          <span className="font-medium">Hint {hint.level}: </span>
          {hint.text}
        </p>
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
  onQuestionOpened?: () => void;
} = {}) {
  const { status: sessionStatus } = useSession();
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
  const [topic, setTopic] = useState('');
  const [commandTerm, setCommandTerm] = useState('');
  const [onlyBookmarked, setOnlyBookmarked] = useState(false);
  /** Ids the signed-in user has starred, so a list row can draw a filled star. */
  const [bookmarked, setBookmarked] = useState<Set<number>>(new Set());

  const [questions, setQuestions] = useState<Summary[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selected, setSelected] = useState<FullQuestion | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    // Signed-out users simply have none; a 401 here is not an error worth
    // surfacing, it just means no stars are drawn.
    fetch('/api/bank/bookmarks')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && setBookmarked(new Set<number>(data.questionIds ?? [])))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    fetch(`/api/bank/questions?action=filters&scope=${scope}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && setFilters({ ...EMPTY_FILTERS, ...data }))
      .catch(() => setFilters(EMPTY_FILTERS));
  }, [scope]);

  useEffect(() => {
    // The bank needs a session, so there is nothing to ask for until we have
    // one. Fetching while `loading` would also fire a 401 on first paint for
    // every signed-in student, before the session resolves.
    if (sessionStatus !== 'authenticated') return;

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
    if (commandTerm) params.set('term', commandTerm);
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
  }, [page, subject, year, session, paperNumber, scope, topic, commandTerm, onlyBookmarked, sessionStatus]);

  // Any filter change invalidates the current page number: page 7 of the old
  // result set is rarely page 7 of the new one, and is often past its end.
  const changeFilter = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPage(1);
    setSelected(null);
    setListLoading(true);
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
          onClick={() => setSelected(null)}
          className="text-sm text-accent-text hover:underline"
        >
          ← Back to questions
        </button>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-secondary">
            {selected.paper.subject} · {paperLabel(selected.paper)}
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
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-2 sm:p-4">
      {/* The sidebar badges Practice as "Preview" and every other entrance to
          the bank carries the matching banner -- /bank, /bank/papers/[id] and
          the legacy QuestionsDatabase. This component had none, and it is the
          default body of the tab, so the one surface students actually open
          was the one that never explained itself. The banner text is also
          where self-marking is described, which is why meeting it cold made
          the intended flow read as a broken AI feature. */}
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
          onChange={(e) => changeFilter(setSubject)(e.target.value)}
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
        {/* Hidden while the bank has no topics at all, rather than offered as
          * a dropdown that filters everything down to nothing. Tagging is part
          * of the model pass a crop-only run skips, so this appears on its own
          * once that has run. */}
        {filters.topics.length > 0 && (
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
        {/* Same rule as topics: hidden until the command-term backfill has run
          * for at least one subject in scope. Drilling one term at a time is
          * how a student fixes answering "evaluate" like "describe". */}
        {filters.commandTerms.length > 0 && (
          <select
            aria-label="Command term"
            value={commandTerm}
            onChange={(e) => changeFilter(setCommandTerm)(e.target.value)}
            className="col-span-2 rounded-md border border-strong px-2 py-1.5 text-sm bg-surface sm:col-span-4"
          >
            <option value="">All command terms</option>
            {filters.commandTerms.map((option) => (
              <option key={option} value={option}>{commandTermLabel(option)}</option>
            ))}
          </select>
        )}
      </div>

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
          <p className="text-sm">No questions match those filters.</p>
        </div>
      )}

      <ul className="space-y-2">
        {questions.map((question) => (
          <li
            key={question.id}
            // The star is its own control, so the row cannot be one big
            // button -- a button inside a button is invalid and the inner one
            // stops responding. The row is a container; the open action and
            // the star are siblings inside it.
            className="flex items-center rounded-lg border border-line bg-surface hover:border-strong hover:bg-surface-hover dark:hover:bg-gray-700/40"
          >
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
              </span>
              {question.hasMarkScheme && (
                <span className="shrink-0 rounded-full bg-accent-subtle px-2 py-0.5 text-[11px] text-accent-text">
                  Mark scheme
                </span>
              )}
            </button>
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
