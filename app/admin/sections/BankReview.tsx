'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Loader2 } from 'lucide-react';
import { adminFetch } from '../lib/fetch';
import { ErrorBox, LoadingSpinner } from './AdminDashboard';
import { useConfirm } from '../../components/useConfirm';

type Strip = { url: string; page: number; width: number | null; height: number | null };
type Paper = {
  id: number; board: string; year: number; session: string; paperNumber: number;
  variant: number; timezone: string | null; docType: string;
  subject: { name: string; code: string; level: string | null };
};
type ReviewItem = {
  id: number; issueType: string; severity: string; message: string; status: string;
  createdAt: string; reviewedBy: string | null; reviewedAt: string | null; reviewNote: string | null; paper: Paper | null;
  question: null | {
    id: number; rootNumber: number; bodyMd: string; totalMarks: number | null;
    confidence: number; status: string; reviewedBy: string | null; reviewedAt: string | null; strips: Strip[];
    openFlags: Array<{ id: number; issueType: string; severity: string; message: string }>;
    markScheme: null | { status: string; answerMd: string; answerLetter: string | null; strips: Strip[] };
  };
};
type ReviewResponse = { items: ReviewItem[]; total: number; page: number; pageSize: number; totalPages: number };
type Status = 'open' | 'resolved' | 'dismissed' | 'all';
type Severity = 'high' | 'medium' | 'low' | 'all';
type Scope = 'questions' | 'papers' | 'all' | 'unflagged';

function label(paper: Paper | null, question: ReviewItem['question']) {
  if (!paper) return question ? `Question ${question.rootNumber}` : 'Unknown paper';
  const variant = paper.variant ? `${paper.paperNumber}${paper.variant}` : paper.paperNumber;
  return `${paper.subject.name} · ${paper.year} ${paper.session} · Paper ${variant}${question ? ` · Q${question.rootNumber}` : ` · ${paper.docType.toUpperCase()}`}`;
}

function StripGallery({ strips, title }: { strips: Strip[]; title: string }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {strips.length === 0 ? <p className="text-sm text-muted">No source crop is available.</p> : (
        <div className="space-y-3">
          {strips.map((strip, index) => (
            <figure key={`${strip.url}-${index}`} className="rounded-lg border border-line bg-surface p-2">
              {/* Browser-native image sizing preserves the entire source strip. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={strip.url} alt={`${title}, strip ${index + 1}, page ${strip.page}`} className="w-full h-auto" loading="lazy" />
              <figcaption className="mt-1 text-xs text-muted">Page {strip.page} · strip {index + 1}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}

export default function BankReview() {
  const { confirm, confirmDialog } = useConfirm();
  const [status, setStatus] = useState<Status>('open');
  const [severity, setSeverity] = useState<Severity>('high');
  // Papers, not questions. Measured against production on 26 Sep, after the
  // duplicate flags were removed: of 35,766 open flags, every `high` and
  // `medium` one is paper-level, and all 1,549 question-level flags are `low`.
  // So the obvious-looking default of questions+high matched exactly nothing,
  // and the panel opened on an empty queue with no hint that two filters had to
  // change. Paper-level high flags are also the work that matters: all 3,289
  // held questions are blocked by one, so none can be published until these are
  // cleared -- the `unflagged` scope, which lists held questions with no blocker,
  // is currently empty for exactly that reason.
  const [scope, setScope] = useState<Scope>('papers');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ReviewResponse | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ status, severity, scope, page: String(page) });
      const response = await adminFetch<ReviewResponse>(`/api/admin/bank-review?${params}`);
      setData(response);
      setSelectedId((current) => response.items.some((item) => item.id === current) ? current : response.items[0]?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load the review queue');
    } finally {
      setLoading(false);
    }
  }, [status, severity, scope, page]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const act = async (payload: Record<string, string | number>) => {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const response = await adminFetch<{ questionsHeld?: number }>(
        '/api/admin/bank-review', { method: 'PATCH', body: JSON.stringify(payload) });
      await load();
      return response;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Review action failed');
      return null;
    } finally {
      setWorking(false);
    }
  };

  /**
   * Reopening a paper-level flag holds every published question on that paper,
   * not just the one on screen -- a median of 10 and up to 44 -- and there is no
   * record of which were published beforehand, so putting them back is manual
   * and one at a time. Hence a confirmation, and a count afterwards: the action
   * is legitimate for a paper-wide problem, it just must not be a surprise.
   */
  const reopenFlag = async (item: ReviewItem) => {
    const paperWide = item.question === null;
    const approved = await confirm({
      title: paperWide ? 'Reopen this paper-level flag?' : 'Reopen this flag?',
      message: paperWide
        ? 'This holds every published question on the paper, not only this flag. Each one has to be republished individually afterwards.'
        : 'This holds the question again until the flag is resolved.',
      confirmLabel: 'Reopen flag',
      destructive: true,
    });
    if (!approved) return;
    const response = await act({ flagId: item.id, action: 'reopen' });
    if (response && typeof response.questionsHeld === 'number' && response.questionsHeld > 0) {
      setNotice(`${response.questionsHeld} question${response.questionsHeld === 1 ? '' : 's'} held and withdrawn from search.`);
    }
  };

  const selected = data?.items.find((item) => item.id === selectedId) ?? null;
  const otherOpenFlags = selected?.question?.openFlags.filter((flag) => flag.id !== selected.id) ?? [];

  const changeQuestionStatus = async (item: ReviewItem) => {
    if (!item.question) return;
    const action = item.question.status === 'published' ? 'hold' : 'publish';
    if (action === 'publish') {
      const approved = await confirm({
        title: 'Publish this reviewed question?',
        message: 'Check the full source crop and transcription first. Publishing makes the question available to students.',
        confirmLabel: 'Publish question',
      });
      if (!approved) return;
    }
    await act({ questionId: item.question.id, action });
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      {confirmDialog}
      <header>
        <h1 className="text-2xl font-bold">Question bank review</h1>
        <p className="mt-1 text-sm text-muted">Inspect source crops and transcription, then record a decision for each QA flag. Publishing a question is a separate step.</p>
      </header>

      {error && <ErrorBox message={error} />}
      {notice && <p className="rounded-md border border-strong bg-surface px-3 py-2 text-sm text-secondary">{notice}</p>}

      <div className="flex flex-wrap gap-3 rounded-lg border border-line bg-surface p-3">
        <label className="text-xs font-medium text-secondary">Status
          <select value={status} disabled={scope === 'unflagged'} onChange={(event) => { setStatus(event.target.value as Status); setPage(1); }} className="mt-1 block rounded-md border border-strong bg-surface px-3 py-2 text-sm text-primary disabled:opacity-50">
            <option value="open">Open</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option><option value="all">All</option>
          </select>
        </label>
        <label className="text-xs font-medium text-secondary">Severity
          <select value={severity} disabled={scope === 'unflagged'} onChange={(event) => { setSeverity(event.target.value as Severity); setPage(1); }} className="mt-1 block rounded-md border border-strong bg-surface px-3 py-2 text-sm text-primary disabled:opacity-50">
            <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option><option value="all">All</option>
          </select>
        </label>
        <label className="text-xs font-medium text-secondary">Applies to
          <select value={scope} onChange={(event) => { setScope(event.target.value as Scope); setPage(1); }} className="mt-1 block rounded-md border border-strong bg-surface px-3 py-2 text-sm text-primary">
            <option value="questions">Question flags</option><option value="papers">Paper flags</option><option value="unflagged">Held without blockers</option><option value="all">All flags</option>
          </select>
        </label>
        <p className="self-end pb-2 text-sm text-muted">{data?.total.toLocaleString() ?? '—'} matching flags</p>
      </div>

      {loading && !data ? <LoadingSpinner /> : data && (
        <div className="grid gap-4 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
          <div className="space-y-2">
            {data.items.length === 0 && <p className="rounded-lg border border-line bg-surface p-5 text-sm text-muted">No flags match these filters.</p>}
            {data.items.map((item) => (
              <button key={item.id} type="button" onClick={() => setSelectedId(item.id)}
                className={`w-full rounded-lg border p-3 text-left ${selectedId === item.id ? 'border-accent bg-surface' : 'border-line bg-surface hover:bg-surface-hover'}`}>
                <span className="text-xs font-semibold uppercase text-secondary">{item.severity} · {item.issueType.replaceAll('_', ' ')}</span>
                <span className="mt-1 block text-sm font-medium">{label(item.paper, item.question)}</span>
                <span className="mt-1 block text-xs text-muted line-clamp-2">{item.message}</span>
              </button>
            ))}
            {data.totalPages > 1 && (
              <div className="flex items-center justify-between pt-2 text-sm">
                <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} className="rounded-md border border-strong p-2 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
                <span>Page {page} of {data.totalPages}</span>
                <button type="button" aria-label="Next page" disabled={page >= data.totalPages} onClick={() => setPage((value) => value + 1)} className="rounded-md border border-strong p-2 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
              </div>
            )}
          </div>

          {selected && (
            <article className="min-w-0 space-y-5 rounded-lg border border-line bg-surface p-4">
              <div>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h2 className="text-lg font-semibold">{label(selected.paper, selected.question)}</h2>
                  {selected.paper && <a href={`/api/admin/bank-review/paper?id=${selected.paper.id}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-accent-text hover:underline">Source PDF <ExternalLink className="h-3.5 w-3.5" /></a>}
                </div>
                <p className="mt-2 text-sm font-medium">{selected.message}</p>
                <p className="mt-1 text-xs text-muted">{selected.id < 0 ? 'Held question' : `Flag #${selected.id}`} · {selected.status} · {new Date(selected.createdAt).toLocaleString()}</p>
                {selected.reviewedAt && <p className="mt-1 text-xs text-muted">Reviewed {new Date(selected.reviewedAt).toLocaleString()} by {selected.reviewedBy}</p>}
                {selected.reviewNote && <p className="mt-1 text-sm text-secondary">Reviewer note: {selected.reviewNote}</p>}
                {selected.question && <p className="mt-1 text-xs text-muted">Question status: {selected.question.status.replaceAll('_', ' ')} · {selected.question.openFlags.length} open question flag(s){selected.question.openFlags.length === 20 ? ' shown' : ''}</p>}
              </div>

              {selected.id > 0 && selected.status === 'open' && <label className="block text-xs font-medium text-secondary">Review note (required for a false alarm)
                <textarea value={notes[selected.id] ?? ''} maxLength={1000} onChange={(event) => setNotes((current) => ({ ...current, [selected.id]: event.target.value }))} rows={2} className="mt-1 block w-full rounded-md border border-strong bg-surface p-2 text-sm text-primary" placeholder="What did you verify or why is this flag incorrect?" />
              </label>}
              <div className="flex flex-wrap gap-2">
                {selected.id > 0 && (selected.status === 'open' ? <>
                  <button type="button" disabled={working} onClick={() => act({ flagId: selected.id, action: 'resolve', note: notes[selected.id] ?? '' })} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50">Resolved after checking</button>
                  <button type="button" disabled={working || !(notes[selected.id] ?? '').trim()} onClick={() => act({ flagId: selected.id, action: 'dismiss', note: notes[selected.id] ?? '' })} className="rounded-md border border-strong px-3 py-2 text-sm disabled:opacity-50">False alarm</button>
                </> : <button type="button" disabled={working} onClick={() => void reopenFlag(selected)} className="rounded-md border border-strong px-3 py-2 text-sm disabled:opacity-50">Reopen flag</button>)}
                {selected.question && <button type="button" disabled={working} onClick={() => void changeQuestionStatus(selected)} className="rounded-md border border-strong px-3 py-2 text-sm disabled:opacity-50">{selected.question.status === 'published' ? 'Hold question' : 'Publish reviewed question'}</button>}
                {working && <Loader2 className="h-5 w-5 animate-spin text-muted" />}
              </div>
              <p className="text-xs text-muted">Publishing requires a source crop and no open high or medium flags on the question or its paper. It does not publish the mark scheme.</p>

              {otherOpenFlags.length > 0 && <section className="rounded-md bg-surface-raised p-3 text-sm">
                <h3 className="font-semibold">Other open flags on this question</h3>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {otherOpenFlags.map((flag) => <li key={flag.id}>{flag.severity}: {flag.message}</li>)}
                </ul>
              </section>}

              {selected.question && <>
                <StripGallery strips={selected.question.strips} title="Question source" />
                {selected.question.markScheme && <StripGallery strips={selected.question.markScheme.strips} title="Mark scheme source" />}
                <div className="grid gap-3 xl:grid-cols-2">
                  <section><h3 className="text-sm font-semibold">Question transcription</h3><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-raised p-3 text-xs">{selected.question.bodyMd || '(empty)'}</pre></section>
                  <section><h3 className="text-sm font-semibold">Mark scheme transcription</h3><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-raised p-3 text-xs">{selected.question.markScheme?.answerMd || selected.question.markScheme?.answerLetter || '(none)'}</pre></section>
                </div>
              </>}
            </article>
          )}
        </div>
      )}
    </div>
  );
}
