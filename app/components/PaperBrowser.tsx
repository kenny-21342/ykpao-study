'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  BookOpen,
  ChevronRight,
  Download,
  FileText,
  GraduationCap,
  Layers,
  Loader2,
  Music,
  RotateCcw,
} from 'lucide-react';
import { documentLabel, type PaperInstance } from '@/lib/paper-catalogue';

type Curriculum = {
  id: string;
  board: string;
  qualification: string;
  label: string;
  subjectCount: number;
  paperCount: number;
};

type SubjectOption = { code: string; name: string; paperCount: number };
type YearOption = { year: number; paperCount: number };
type SessionOption = { session: string; label: string; paperCount: number };

type CatalogueResponse = {
  curricula: Curriculum[];
  subjects: SubjectOption[];
  years: YearOption[];
  sessions: SessionOption[];
};

type Selection = {
  curriculum: string | null;
  subject: string | null;
  year: number | null;
  session: string | null;
};

const EMPTY_SELECTION: Selection = {
  curriculum: null,
  subject: null,
  year: null,
  session: null,
};

const CARD =
  'rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-green-500 dark:hover:border-green-500 hover:shadow-md transition-all text-left';
const CARD_ACTIVE =
  'rounded-lg border-2 border-green-500 bg-green-50 dark:bg-green-900/20 text-left shadow-sm';

function formatBytes(bytes: number | null) {
  if (!bytes) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Read the cascade out of the URL so a chosen paper is linkable. */
function selectionFromSearch(search: string): Selection {
  const params = new URLSearchParams(search);
  const year = params.get('year');
  return {
    curriculum: params.get('curriculum'),
    subject: params.get('subject'),
    year: year ? Number.parseInt(year, 10) : null,
    session: params.get('session'),
  };
}

function searchFromSelection(selection: Selection): string {
  const params = new URLSearchParams();
  if (selection.curriculum) params.set('curriculum', selection.curriculum);
  if (selection.subject) params.set('subject', selection.subject);
  if (selection.year !== null) params.set('year', String(selection.year));
  if (selection.session) params.set('session', selection.session);
  const query = params.toString();
  return query ? `?${query}` : '';
}

function Skeleton({ count, height = 'h-20' }: { count: number; height?: string }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className={`${height} rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse`}
        />
      ))}
    </div>
  );
}

function Step({
  index,
  title,
  children,
  innerRef,
}: {
  index: number;
  title: string;
  children: React.ReactNode;
  innerRef?: React.Ref<HTMLElement>;
}) {
  return (
    <section ref={innerRef} className="scroll-mt-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-green-500 text-xs font-semibold text-white">
          {index}
        </span>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

export default function PaperBrowser() {
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [catalogue, setCatalogue] = useState<CatalogueResponse>({
    curricula: [],
    subjects: [],
    years: [],
    sessions: [],
  });
  const [instances, setInstances] = useState<PaperInstance[]>([]);
  const [loadingCatalogue, setLoadingCatalogue] = useState(true);
  const [loadingPapers, setLoadingPapers] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore the cascade from the URL on first paint and on back/forward.
  useEffect(() => {
    const sync = () => setSelection(selectionFromSearch(window.location.search));
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const selectionKey = useMemo(() => JSON.stringify(selection), [selection]);

  /**
   * Bring the step a choice just opened into view.
   *
   * The cascade reveals each step below the last, so on a laptop the newly
   * relevant choices open under the fold and the picker looks like it did
   * nothing. Scrolling is keyed on how deep the selection now runs rather than
   * on which field changed, so clearing a step scrolls back up to it too.
   *
   * The first paint is skipped: restoring a full selection from the URL would
   * otherwise yank a freshly loaded page down to the papers list.
   */
  const stepRefs = useRef<(HTMLElement | null)[]>([]);
  const depth = [selection.curriculum, selection.subject, selection.year, selection.session]
    .filter((value) => value !== null && value !== '').length;
  const lastDepth = useRef<number | null>(null);

  useEffect(() => {
    if (lastDepth.current === null) {
      lastDepth.current = depth;
      return;
    }
    if (lastDepth.current === depth) return;
    lastDepth.current = depth;
    if (depth === 0) return;

    // Steps are 1-indexed on screen; depth 1 (a curriculum chosen) opens step 2.
    const target = stepRefs.current[Math.min(depth + 1, 5)];
    if (!target) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  }, [depth]);

  // History is pushed here rather than inside a setState updater: updaters run
  // during render, and navigating there triggers a router update mid-render.
  const update = useCallback(
    (next: Partial<Selection>) => {
      const merged = { ...selection, ...next };
      window.history.pushState(null, '', `${window.location.pathname}${searchFromSelection(merged)}`);
      setSelection(merged);
    },
    [selection],
  );

  useEffect(() => {
    const controller = new AbortController();
    const current: Selection = JSON.parse(selectionKey);

    const params = new URLSearchParams();
    if (current.curriculum) params.set('curriculum', current.curriculum);
    if (current.subject) params.set('subject', current.subject);
    if (current.year !== null) params.set('year', String(current.year));

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingCatalogue(true);
    fetch(`/api/papers/catalogue?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json()).error ?? 'Failed to load');
        return response.json() as Promise<CatalogueResponse>;
      })
      .then((data) => {
        setCatalogue(data);
        setError(null);
      })
      .catch((cause) => {
        if (cause.name !== 'AbortError') setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingCatalogue(false);
      });

    return () => controller.abort();
  }, [selectionKey]);

  useEffect(() => {
    const current: Selection = JSON.parse(selectionKey);
    if (!current.subject || current.year === null || !current.session) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInstances([]);
      return;
    }

    const controller = new AbortController();
    const params = new URLSearchParams({
      subject: current.subject,
      year: String(current.year),
      session: current.session,
    });

    setLoadingPapers(true);
    fetch(`/api/papers/catalogue/papers?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json()).error ?? 'Failed to load');
        return response.json() as Promise<{ instances: PaperInstance[] }>;
      })
      .then((data) => {
        setInstances(data.instances);
        setError(null);
      })
      .catch((cause) => {
        if (cause.name !== 'AbortError') setError(cause.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingPapers(false);
      });

    return () => controller.abort();
  }, [selectionKey]);

  const activeCurriculum = catalogue.curricula.find((c) => c.id === selection.curriculum);
  const activeSubject = catalogue.subjects.find((s) => s.code === selection.subject);

  return (
    <div className="space-y-8 p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Past Papers</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Browse complete papers by curriculum, subject, year and exam series.
          </p>
        </div>
        {(selection.curriculum || selection.subject) && (
          <button
            onClick={() => {
              window.history.pushState(null, '', window.location.pathname);
              setSelection(EMPTY_SELECTION);
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Start over
          </button>
        )}
      </header>

      {/* Breadcrumb of the cascade so far. */}
      {(activeCurriculum || activeSubject) && (
        <nav className="flex flex-wrap items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300">
          {activeCurriculum && (
            <button
              onClick={() => update({ subject: null, year: null, session: null })}
              className="rounded-sm px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {activeCurriculum.label}
            </button>
          )}
          {activeSubject && (
            <>
              <ChevronRight className="h-3.5 w-3.5 text-gray-400" />
              <button
                onClick={() => update({ year: null, session: null })}
                className="rounded-sm px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                {activeSubject.name}
              </button>
            </>
          )}
          {selection.year !== null && (
            <>
              <ChevronRight className="h-3.5 w-3.5 text-gray-400" />
              <button
                onClick={() => update({ session: null })}
                className="rounded-sm px-2 py-1 hover:bg-gray-100 dark:hover:bg-gray-700"
              >
                {selection.year}
              </button>
            </>
          )}
        </nav>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </div>
      )}

      {/* 1. Curriculum */}
      <Step index={1} title="Curriculum" innerRef={(node) => { stepRefs.current[1] = node; }}>
        {loadingCatalogue && catalogue.curricula.length === 0 ? (
          <Skeleton count={3} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {catalogue.curricula.map((curriculum) => (
              <button
                key={curriculum.id}
                onClick={() =>
                  update({
                    curriculum: curriculum.id,
                    subject: null,
                    year: null,
                    session: null,
                  })
                }
                className={`${selection.curriculum === curriculum.id ? CARD_ACTIVE : CARD} p-4`}
              >
                <div className="flex items-center gap-2">
                  <GraduationCap className="h-5 w-5 text-green-600 dark:text-green-400" />
                  <span className="font-semibold text-gray-900 dark:text-white">
                    {curriculum.label}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {curriculum.subjectCount} subjects · {curriculum.paperCount.toLocaleString()} papers
                </p>
              </button>
            ))}
          </div>
        )}
      </Step>

      {/* 2. Subject */}
      {selection.curriculum && (
        <Step index={2} title="Subject" innerRef={(node) => { stepRefs.current[2] = node; }}>
          {loadingCatalogue && catalogue.subjects.length === 0 ? (
            <Skeleton count={8} />
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {catalogue.subjects.map((subject) => (
                <button
                  key={subject.code}
                  onClick={() =>
                    update({ subject: subject.code, year: null, session: null })
                  }
                  className={`${selection.subject === subject.code ? CARD_ACTIVE : CARD} p-3`}
                >
                  <div className="flex items-start gap-2">
                    <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                    <div className="min-w-0">
                      <p className="truncate font-medium text-gray-900 dark:text-white">
                        {subject.name}
                      </p>
                      {/* Two Cambridge syllabuses share the name "Computer
                          Science", so the code is what tells them apart. */}
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {subject.code.startsWith('ib-') ? '' : `${subject.code} · `}
                        {subject.paperCount} papers
                      </p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Step>
      )}

      {/* 3. Year */}
      {selection.subject && (
        <Step index={3} title="Year" innerRef={(node) => { stepRefs.current[3] = node; }}>
          {loadingCatalogue && catalogue.years.length === 0 ? (
            <Skeleton count={6} height="h-12" />
          ) : (
            <div className="flex flex-wrap gap-2">
              {catalogue.years.map((year) => (
                <button
                  key={year.year}
                  onClick={() => update({ year: year.year, session: null })}
                  className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                    selection.year === year.year
                      ? 'bg-green-500 text-white'
                      : 'border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-green-500 hover:text-green-600 dark:hover:text-green-400'
                  }`}
                >
                  {year.year}
                </button>
              ))}
            </div>
          )}
        </Step>
      )}

      {/* 4. Exam series */}
      {selection.year !== null && (
        <Step index={4} title="Exam series" innerRef={(node) => { stepRefs.current[4] = node; }}>
          <div className="flex flex-wrap gap-2">
            {catalogue.sessions.map((session) => (
              <button
                key={session.session}
                onClick={() => update({ session: session.session })}
                className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                  selection.session === session.session
                    ? 'bg-green-500 text-white'
                    : 'border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-green-500 hover:text-green-600 dark:hover:text-green-400'
                }`}
              >
                {session.label}
                <span className="ml-2 text-xs opacity-70">{session.paperCount}</span>
              </button>
            ))}
          </div>
        </Step>
      )}

      {/* 5. Paper */}
      {selection.session && (
        <Step index={5} title="Paper" innerRef={(node) => { stepRefs.current[5] = node; }}>
          {loadingPapers ? (
            <div className="flex items-center gap-2 py-8 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading papers…
            </div>
          ) : instances.length === 0 ? (
            <p className="py-8 text-sm text-gray-500 dark:text-gray-400">
              No papers found for this series.
            </p>
          ) : (
            <div className="space-y-2">
              {instances.map((instance) => (
                <div
                  key={instance.key}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3"
                >
                  <div className="flex items-center gap-3">
                    <Layers className="h-4 w-4 text-gray-400" />
                    <div>
                      <p className="font-medium text-gray-900 dark:text-white">{instance.label}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        {instance.subjectName} · {instance.year} · {instance.sessionLabel}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {instance.documents.map((document) => (
                      <span key={document.id} className="inline-flex items-center">
                        <Link
                          href={`/papers/${document.id}`}
                          className="inline-flex items-center gap-1.5 rounded-l-md border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:border-green-500 hover:text-green-600 dark:hover:text-green-400"
                        >
                          {document.docType === 'au' ? (
                            <Music className="h-3.5 w-3.5" />
                          ) : (
                            <FileText className="h-3.5 w-3.5" />
                          )}
                          {documentLabel(document)}
                          {document.pageCount ? (
                            <span className="text-xs text-gray-400">{document.pageCount}p</span>
                          ) : null}
                        </Link>
                        <a
                          href={`/api/papers/${document.id}/file?download=1`}
                          title={`Download ${document.filename}${
                            formatBytes(document.sizeBytes)
                              ? ` (${formatBytes(document.sizeBytes)})`
                              : ''
                          }`} aria-label={`Download ${document.filename}${
                            formatBytes(document.sizeBytes)
                              ? ` (${formatBytes(document.sizeBytes)})`
                              : ''
                          }`}
                          className="inline-flex items-center rounded-r-md border border-l-0 border-gray-300 dark:border-gray-600 px-2 py-1.5 text-gray-500 hover:border-green-500 hover:text-green-600 dark:hover:text-green-400"
                        >
                          <Download className="h-3.5 w-3.5" />
                        </a>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Step>
      )}
    </div>
  );
}
