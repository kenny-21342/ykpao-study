'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Columns2, Download, Loader2, Music } from 'lucide-react';
import { documentLabel } from '@/lib/paper-catalogue';
import type { PaperInstance } from '@/lib/paper-catalogue';
import { useScreenContext } from '@/app/components/ScreenContext';
import PDFViewer from '@/app/components/PDFViewer';

type PaperResponse = {
  paperId: number;
  activeDocType: string;
  curriculum: { id: string; label: string };
  instance: PaperInstance;
};

export default function PaperViewer({ paperId }: { paperId: number }) {
  const [data, setData] = useState<PaperResponse | null>(null);
  const [activeId, setActiveId] = useState(paperId);
  /** Documents opened so far: each stays mounted so switching back is instant. */
  const [opened, setOpened] = useState<Set<number>>(() => new Set([paperId]));
  const [error, setError] = useState<string | null>(null);
  /** Question paper and mark scheme next to each other. Remembered for the tab. */
  const [split, setSplit] = useState(() => {
    // Nothing split is rendered before the paper loads, so reading storage here
    // cannot disagree with the server's markup.
    try {
      return typeof window !== 'undefined' && sessionStorage.getItem('papers:split:v1') === '1';
    } catch {
      return false;
    }
  });
  const { update } = useScreenContext();

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/papers/${paperId}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json()).error ?? 'Failed to load paper');
        return response.json() as Promise<PaperResponse>;
      })
      .then((payload) => {
        setData(payload);
        setActiveId(payload.paperId);
        setError(null);
      })
      .catch((cause) => {
        if (cause.name !== 'AbortError') setError(cause.message);
      });
    return () => controller.abort();
  }, [paperId]);

  const toggleSplit = () => {
    setSplit((current) => {
      try {
        sessionStorage.setItem('papers:split:v1', current ? '0' : '1');
      } catch {
        /* see above */
      }
      return !current;
    });
  };

  // Let the AI assistant know which paper is on screen.
  useEffect(() => {
    if (!data) return;
    const active = data.instance.documents.find((d) => d.id === activeId);
    const { subjectName, subjectCode, year, sessionLabel, label } = data.instance;
    update({
      tab: 'past-papers',
      description: `Reading the ${active?.docTypeLabel ?? 'paper'} for ${subjectName} ${year} ${sessionLabel}, ${label}`,
      data: {
        questionSubject: subjectName,
        // CAIE codes feed RAG filtering; IB slugs are ignored downstream.
        subjectCode: subjectCode.startsWith('ib-') ? undefined : subjectCode,
      },
    });
    // update is intentionally omitted: outside the provider the hook returns a
    // fresh no-op each render, which would re-run this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, activeId]);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="rounded-lg border border-danger-border bg-danger-subtle p-4 text-sm text-danger">
          {error}
        </div>
        <Link href="/papers" className="mt-4 inline-flex items-center gap-1.5 text-sm text-accent-text">
          <ArrowLeft className="h-4 w-4" />
          Back to past papers
        </Link>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading paper…
      </div>
    );
  }

  const active = data.instance.documents.find((d) => d.id === activeId) ?? data.instance.documents[0];

  const questionPaper = data.instance.documents.find((d) => d.docType === 'qp');
  const markScheme = data.instance.documents.find((d) => d.docType === 'ms');
  const canSplit = Boolean(questionPaper && markScheme);
  const sideBySide = split && canSplit;

  return (
    <div className={`mx-auto space-y-4 p-4 md:p-6 ${sideBySide ? 'max-w-none' : 'max-w-6xl'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/papers"
            className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-accent-text"
          >
            <ArrowLeft className="h-4 w-4" />
            Past papers
          </Link>
          <h1 className="mt-1 text-xl font-bold text-primary">
            {data.instance.subjectName} · {data.instance.label}
          </h1>
          <p className="text-sm text-muted">
            {data.curriculum.label} · {data.instance.year} · {data.instance.sessionLabel}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {canSplit ? (
            <button
              type="button"
              onClick={toggleSplit}
              aria-pressed={sideBySide}
              className={`hidden items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium transition-colors lg:inline-flex ${
                sideBySide
                  ? 'border-accent bg-accent-subtle text-accent-text'
                  : 'border-line text-secondary hover:bg-surface-hover'
              }`}
            >
              <Columns2 className="h-4 w-4" />
              Side by side
            </button>
          ) : null}
          <a
            href={`/api/papers/${active.id}/file?download=1`}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
          >
            <Download className="h-4 w-4" />
            Download
          </a>
        </div>
      </div>

      {sideBySide && questionPaper && markScheme ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {[questionPaper, markScheme].map((document) => (
            <section key={document.id} className="overflow-hidden rounded-lg border border-line bg-surface">
              <h2 className="border-b border-line px-4 py-2 text-sm font-semibold text-primary">
                {documentLabel(document)}
              </h2>
              <PDFViewer fileUrl={`/api/papers/${document.id}/file`} fileName={document.filename} />
            </section>
          ))}
        </div>
      ) : (
        <>

      {/* One tab per document in this sitting: paper, audio, mark scheme,
          inserts. A listening sitting carries four tracks, all of docType
          `au`, so tabs are labelled by track number rather than by type. */}
      <div className="flex flex-wrap gap-1 border-b border-line">
        {data.instance.documents.map((document) => (
          <button
            key={document.id}
            onClick={() => {
              setActiveId(document.id);
              setOpened((current) => (current.has(document.id) ? current : new Set(current).add(document.id)));
            }}
            className={`-mb-px rounded-t-md border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              document.id === active.id
                ? 'border-accent text-accent-text'
                : 'border-transparent text-muted hover:text-secondary'
            }`}
          >
            {documentLabel(document)}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-line bg-surface overflow-hidden">
        {active.docType === 'au' ? (
          <div className="space-y-3 p-6">
            <div className="flex items-center gap-2 text-primary">
              <Music className="h-5 w-5 text-accent-text" />
              <h2 className="font-semibold">{documentLabel(active)}</h2>
            </div>
            <p className="text-sm text-muted">
              The recording for this listening paper. Play it alongside the question paper and
              score booklet, which are the other tabs above.
            </p>
            {/* preload="metadata" so the duration shows without pulling several
                megabytes for a track the student may not play. */}
            <audio
              key={active.id}
              controls
              preload="metadata"
              className="w-full"
              src={`/api/papers/${active.id}/file`}
            >
              Your browser cannot play audio.{' '}
              <a href={`/api/papers/${active.id}/file?download=1`}>Download the track instead.</a>
            </audio>
          </div>
        ) : null}
        {/* Every PDF opened so far stays mounted, stacked in one grid cell, and
            only the active one is visible. Remounting (the old `key={active.id}`)
            threw the paper away on every tab switch and downloaded it again.
            `invisible` rather than `hidden`: display:none can make the browser's
            PDF plugin reload when it is shown again. */}
        <div className={active.docType === 'au' ? 'hidden' : 'grid'}>
          {data.instance.documents
            .filter((document) => document.docType !== 'au' && (opened.has(document.id) || document.id === active.id))
            .map((document) => (
              <div
                key={document.id}
                className={`col-start-1 row-start-1 ${
                  document.id === active.id ? '' : 'invisible pointer-events-none'
                }`}
                aria-hidden={document.id !== active.id}
              >
                <PDFViewer fileUrl={`/api/papers/${document.id}/file`} fileName={document.filename} />
              </div>
            ))}
        </div>
      </div>
        </>
      )}
    </div>
  );
}
