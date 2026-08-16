'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { ArrowLeft, Download, Loader2 } from 'lucide-react';
import type { PaperInstance } from '@/lib/paper-catalogue';
import { useScreenContext } from '@/app/components/ScreenContext';

// react-pdf touches browser APIs at import time.
const PDFViewer = dynamic(() => import('@/app/components/PDFViewer'), {
  ssr: false,
  loading: () => (
    <div className="flex h-96 items-center justify-center text-sm text-gray-500">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      Loading viewer…
    </div>
  ),
});

type PaperResponse = {
  paperId: number;
  activeDocType: string;
  curriculum: { id: string; label: string };
  instance: PaperInstance;
};

export default function PaperViewer({ paperId }: { paperId: number }) {
  const [data, setData] = useState<PaperResponse | null>(null);
  const [activeId, setActiveId] = useState(paperId);
  const [error, setError] = useState<string | null>(null);
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
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </div>
        <Link href="/papers" className="mt-4 inline-flex items-center gap-1.5 text-sm text-green-600">
          <ArrowLeft className="h-4 w-4" />
          Back to past papers
        </Link>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-gray-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading paper…
      </div>
    );
  }

  const active = data.instance.documents.find((d) => d.id === activeId) ?? data.instance.documents[0];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/papers"
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-green-600 dark:text-gray-400"
          >
            <ArrowLeft className="h-4 w-4" />
            Past papers
          </Link>
          <h1 className="mt-1 text-xl font-bold text-gray-900 dark:text-white">
            {data.instance.subjectName} · {data.instance.label}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {data.curriculum.label} · {data.instance.year} · {data.instance.sessionLabel}
          </p>
        </div>

        <a
          href={`/api/papers/${active.id}/file?download=1`}
          className="inline-flex items-center gap-1.5 rounded-lg bg-green-500 px-4 py-2 text-sm font-medium text-white hover:bg-green-600"
        >
          <Download className="h-4 w-4" />
          Download
        </a>
      </div>

      {/* One tab per document in this sitting: paper, mark scheme, inserts. */}
      <div className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-700">
        {data.instance.documents.map((document) => (
          <button
            key={document.id}
            onClick={() => setActiveId(document.id)}
            className={`-mb-px rounded-t-lg border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
              document.id === active.id
                ? 'border-green-500 text-green-600 dark:text-green-400'
                : 'border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
            }`}
          >
            {document.docTypeLabel}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
        <PDFViewer
          key={active.id}
          fileUrl={`/api/papers/${active.id}/file`}
          fileName={active.filename}
        />
      </div>
    </div>
  );
}
