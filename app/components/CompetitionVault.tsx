'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Search, Loader2, FileText, ExternalLink, Code2, Tag, BookOpen } from 'lucide-react';
import { sanitizeHtml } from '@/lib/sanitize-html';

type StepQuestion = {
  id: number;
  code: string;
  yearLabel: string;
  paper: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  imageUrl: string | null;
  pdfUrl: string | null;
  texUrl: string | null;
};

/**
 * Competition vault — STEP questions (and future AMC/AIME), shown only after
 * the user has unlocked the vault via the easter egg. Mirrors the left-list +
 * top-search + right-detail layout of the main practice surface.
 */
export default function CompetitionVault() {
  const [questions, setQuestions] = useState<StepQuestion[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [paperFilter, setPaperFilter] = useState<string>('');
  const [yearFilter, setYearFilter] = useState<string>('');
  const [selected, setSelected] = useState<StepQuestion | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: '50' });
    if (search) params.set('q', search);
    if (paperFilter) params.set('paper', paperFilter);
    if (yearFilter) params.set('year', yearFilter);
    try {
      const res = await fetch(`/api/step?${params}`);
      if (!res.ok) {
        setQuestions([]);
        return;
      }
      const data = await res.json();
      setQuestions(data.questions ?? []);
      setTotal(data.total ?? 0);
      setTotalPages(data.totalPages ?? 1);
    } finally {
      setLoading(false);
    }
  }, [page, search, paperFilter, yearFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Debounce search input.
  useEffect(() => {
    const t = setTimeout(() => { if (page !== 1) setPage(1); else load(); }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const distinctYears = useMemo(() => {
    // Cheap client-side derive for the filter dropdown.
    return ['Spec', '87', '88', '89', '90', '91', '92', '93', '94', '95', '96', '97', '98', '99',
      '00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18'];
  }, []);

  return (
    <div className="h-full flex flex-col">
      {/* Top bar: search + filters */}
      <div className="px-4 py-3 border-b border-line bg-surface flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by code (e.g. 16-S1-Q1) or label (e.g. Inequalities)…"
            className="w-full pl-9 pr-3 py-2 bg-surface-raised border border-line rounded-md text-sm text-primary focus:outline-none focus:ring-2 focus:ring-green-500"
          />
        </div>
        <select
          value={paperFilter}
          onChange={(e) => { setPaperFilter(e.target.value); setPage(1); }}
          className="px-2 py-2 bg-surface-raised border border-line rounded-md text-sm text-secondary"
        >
          <option value="">All papers</option>
          <option value="S1">STEP I</option>
          <option value="S2">STEP II</option>
          <option value="S3">STEP III</option>
        </select>
        <select
          value={yearFilter}
          onChange={(e) => { setYearFilter(e.target.value); setPage(1); }}
          className="px-2 py-2 bg-surface-raised border border-line rounded-md text-sm text-secondary"
        >
          <option value="">All years</option>
          {distinctYears.map((y) => <option key={y} value={y}>{y === 'Spec' ? 'Specimen' : `'${y}`}</option>)}
        </select>
        <span className="text-xs text-muted whitespace-nowrap">{total} questions</span>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Left: question list */}
        <div className={`${selected ? 'w-2/5' : 'w-full'} border-r border-line overflow-y-auto`}>
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-6 h-6 animate-spin text-green-500" />
            </div>
          ) : questions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted">
              <BookOpen className="w-10 h-10 mb-2 opacity-50" />
              <p className="text-sm">No questions match.</p>
            </div>
          ) : (
            <ul className="divide-y divide-subtle">
              {questions.map((q) => (
                <li
                  key={q.id}
                  onClick={() => setSelected(q)}
                  className={`px-4 py-3 cursor-pointer transition-colors ${
                    selected?.id === q.id
                      ? 'bg-green-50 dark:bg-green-900/20 border-l-2 border-green-500'
                      : 'hover:bg-surface-hover dark:hover:bg-gray-800/50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Code2 className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                    <span className="font-mono text-sm font-semibold text-primary">
                      {q.code}
                    </span>
                  </div>
                  {q.labels.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {q.labels.slice(0, 4).map((l, i) => (
                        <span
                          key={i}
                          className="text-[10px] px-1.5 py-0.5 rounded-sm bg-surface-raised text-secondary"
                        >
                          {l}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 py-3 text-xs text-muted">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-2 py-1 rounded-sm border border-line disabled:opacity-40"
              >Prev</button>
              <span>Page {page} / {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-2 py-1 rounded-sm border border-line disabled:opacity-40"
              >Next</button>
            </div>
          )}
        </div>

        {/* Right: question detail */}
        {selected && (
          <div className="flex-1 overflow-y-auto bg-surface p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-xl font-bold font-mono text-primary">
                    {selected.code}
                  </h3>
                  <span className="text-xs px-2 py-0.5 rounded-sm bg-surface-raised text-secondary">
                    {selected.paper === 'S1' ? 'STEP I' : selected.paper === 'S2' ? 'STEP II' : 'STEP III'}
                  </span>
                </div>
                {selected.labels.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {selected.labels.map((l, i) => (
                      <span key={i} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-surface-raised text-secondary">
                        <Tag className="w-2.5 h-2.5" /> {l}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={() => setSelected(null)}
                className="text-muted hover:text-secondary"
              >✕</button>
            </div>

            {/* Body (HTML — already sanitised at load time to local images) */}
            <div
              className="prose dark:prose-invert max-w-none text-primary"
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(selected.body) }}
            />

            {/* The question image (rendered by the body too, but shown large here) */}
            {selected.imageUrl && (
              <div className="mt-4">
                <img
                  src={selected.imageUrl}
                  alt={selected.code}
                  className="max-w-full h-auto rounded-md border border-line"
                />
              </div>
            )}

            {/* Source links */}
            {(selected.pdfUrl || selected.texUrl) && (
              <div className="mt-6 pt-4 border-t border-subtle flex items-center gap-4 text-xs text-muted">
                {selected.pdfUrl && (
                  <a href={selected.pdfUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-green-600">
                    <FileText className="w-3.5 h-3.5" /> Full paper PDF <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                {selected.texUrl && (
                  <a href={selected.texUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-green-600">
                    <Code2 className="w-3.5 h-3.5" /> TeX source <ExternalLink className="w-3 h-3" />
                  </a>
                )}
                <span className="ml-auto opacity-60">source: {selected.code.includes('Spec') ? 'STEP Specimen' : 'STEP'}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
