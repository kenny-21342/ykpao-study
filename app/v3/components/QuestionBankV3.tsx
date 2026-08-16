"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search, SlidersHorizontal, X } from "lucide-react";
import { QuestionDocumentRenderer } from "./QuestionDocumentRenderer";
import type { V3FilterMetadata, V3QuestionSummary } from "./types";

type SearchResponse = {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
  items: V3QuestionSummary[];
};

type Filters = Record<string, string[]>;

export function QuestionBankV3() {
  const [metadata, setMetadata] = useState<V3FilterMetadata | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [filters, setFilters] = useState<Filters>({});
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mobileFilters, setMobileFilters] = useState(false);
  const filterKey = useMemo(() => JSON.stringify(filters), [filters]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v3/filters", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json()).error ?? "Could not load filters");
        return response.json() as Promise<V3FilterMetadata>;
      })
      .then(setMetadata)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load filters");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({ page: String(page), pageSize: "12" });
    if (query.trim()) parameters.set("q", query.trim());
    for (const [key, values] of Object.entries(JSON.parse(filterKey) as Filters)) {
      for (const value of values) parameters.append(key, value);
    }
    fetch(`/api/v3/questions?${parameters}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Could not load questions");
        return payload as SearchResponse;
      })
      .then((payload) => {
        setResult(payload);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setError(cause instanceof Error ? cause.message : "Could not load questions");
        }
      });
    return () => controller.abort();
  }, [filterKey, page, query]);

  function toggleFilter(key: string, value: string) {
    setLoading(true);
    setError(null);
    setPage(1);
    setFilters((current) => {
      const selected = new Set(current[key] ?? []);
      if (selected.has(value)) selected.delete(value); else selected.add(value);
      return { ...current, [key]: [...selected] };
    });
  }

  const activeCount = Object.values(filters).reduce((sum, values) => sum + values.length, 0);

  return (
    <main className="v3-main">
      <div className="v3-toolbar-band">
        <div className="v3-toolbar">
          <div>
            <h1>Past paper questions</h1>
            <p>{result ? `${result.total.toLocaleString()} verified root questions` : "Local structured corpus"}</p>
          </div>
          <label className="v3-search">
            <Search aria-hidden="true" />
            <span className="sr-only">Search questions</span>
            <input value={query} onChange={(event) => { setLoading(true); setError(null); setQuery(event.target.value); setPage(1); }} placeholder="Subject, code, or question" />
            {query && <button type="button" onClick={() => { setLoading(true); setError(null); setQuery(""); }} title="Clear search" aria-label="Clear search"><X /></button>}
          </label>
          <button className="v3-mobile-filter-button" type="button" onClick={() => setMobileFilters((value) => !value)} aria-expanded={mobileFilters}>
            <SlidersHorizontal /> Filters {activeCount ? `(${activeCount})` : ""}
          </button>
        </div>
      </div>

      <div className="v3-content-grid">
        <aside className="v3-filters" data-open={mobileFilters}>
          <div className="v3-filter-heading">
            <h2>Filters</h2>
            {activeCount > 0 && <button type="button" onClick={() => { setLoading(true); setError(null); setFilters({}); setPage(1); }}>Clear all</button>}
          </div>
          {metadata ? (
            <>
              <Facet label="Board" filterKey="board" options={metadata.boards.map(option)} selected={filters.board} onToggle={toggleFilter} />
              <Facet label="Qualification" filterKey="qualification" options={metadata.qualifications.map(option)} selected={filters.qualification} onToggle={toggleFilter} />
              <Facet label="Level" filterKey="level" options={metadata.levels.map(option)} selected={filters.level} onToggle={toggleFilter} />
              <Facet label="Subject" filterKey="subject" options={metadata.subjects.map((item) => ({ value: item.id, label: `${item.subjectCode} ${item.name}` }))} selected={filters.subject} onToggle={toggleFilter} />
              <Facet label="Year" filterKey="year" options={metadata.years.map((item) => option(String(item)))} selected={filters.year} onToggle={toggleFilter} />
              <Facet label="Session" filterKey="session" options={metadata.sessions.map(option)} selected={filters.session} onToggle={toggleFilter} />
              <Facet label="Paper type" filterKey="paperType" options={metadata.paperTypes.map(option)} selected={filters.paperType} onToggle={toggleFilter} />
              <Facet label="Variant" filterKey="variant" options={metadata.variants.map(option)} selected={filters.variant} onToggle={toggleFilter} />
              <Facet label="Timezone" filterKey="timezone" options={metadata.timezones.map(option)} selected={filters.timezone} onToggle={toggleFilter} />
              <Facet label="Syllabus topics" filterKey="topic" options={metadata.topics.map((item) => ({ value: item.id, label: item.label }))} selected={filters.topic} onToggle={toggleFilter} />
              <Facet label="Tags" filterKey="tag" options={metadata.tags.map((item) => ({ value: item.id, label: item.label }))} selected={filters.tag} onToggle={toggleFilter} />
            </>
          ) : <div className="v3-filter-skeleton" />}
        </aside>

        <section className="v3-results" aria-busy={loading}>
          {error && (
            <div className="v3-empty" role="status">
              <DatabaseUnavailable />
              <h2>V3 corpus unavailable</h2>
              <p>{error}</p>
            </div>
          )}
          {!error && loading && <QuestionSkeletons />}
          {!error && !loading && result?.items.length === 0 && (
            <div className="v3-empty"><h2>No matching questions</h2><p>Adjust the active filters or search term.</p></div>
          )}
          {!error && !loading && result?.items.map((question) => (
            <article className="v3-question-card" key={question.id}>
              <div className="v3-question-meta">
                <div className="v3-question-number">{question.rootNumber}</div>
                <div>
                  <strong>{question.paper.subjectCode} {question.paper.subjectName}</strong>
                  <span>{question.paper.board} · {question.paper.qualification} · {question.paper.level}</span>
                </div>
                <div className="v3-paper-facts">
                  <span>{question.paper.year}</span>
                  <span>{titleCase(question.paper.session)}</span>
                  <span>{titleCase(question.paper.paperType)}</span>
                  {question.paper.component && <span>Component {question.paper.component}</span>}
                  <span>Paper {question.paper.paperNumber}{question.paper.variant ? ` · Variant ${question.paper.variant}` : ""}{question.paper.timezone ? ` · ${question.paper.timezone}` : ""}</span>
                  {question.marks !== null && <span>{question.marks} marks</span>}
                </div>
              </div>
              <div className="v3-question-body">
                <QuestionDocumentRenderer document={question.document} assets={question.assets} />
              </div>
              <footer className="v3-question-footer">
                <div className="v3-labels">
                  {question.topics.map((topic) => <span key={topic.id} className="v3-topic-label">{topic.label}</span>)}
                  {question.tags.map((tag) => <span key={tag.id} className="v3-tag-label">{tag.label}</span>)}
                </div>
                <Link href={`/v3/questions/${question.id}`}>Open question {question.hasMarkScheme ? "and mark scheme" : ""}</Link>
              </footer>
            </article>
          ))}
          {!error && result && result.pageCount > 1 && (
            <nav className="v3-pagination" aria-label="Question pages">
              <button type="button" onClick={() => { setLoading(true); setError(null); setPage((value) => value - 1); }} disabled={page <= 1} title="Previous page" aria-label="Previous page"><ChevronLeft /></button>
              <span>Page {result.page} of {result.pageCount}</span>
              <button type="button" onClick={() => { setLoading(true); setError(null); setPage((value) => value + 1); }} disabled={page >= result.pageCount} title="Next page" aria-label="Next page"><ChevronRight /></button>
            </nav>
          )}
        </section>
      </div>
    </main>
  );
}

function Facet({ label, filterKey, options, selected = [], onToggle }: {
  label: string;
  filterKey: string;
  options: Array<{ value: string; label: string }>;
  selected?: string[];
  onToggle: (key: string, value: string) => void;
}) {
  if (!options.length) return null;
  return (
    <fieldset className="v3-facet">
      <legend>{label}</legend>
      <div>
        {options.map((item) => (
          <label key={item.value}>
            <input type="checkbox" checked={selected.includes(item.value)} onChange={() => onToggle(filterKey, item.value)} />
            <span>{item.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function option(value: string) { return { value, label: titleCase(value) }; }
function titleCase(value: string) { return value.replace(/-/g, " ").replace(/\b\w/g, (character) => character.toUpperCase()); }

function QuestionSkeletons() {
  return <>{[0, 1, 2].map((item) => <div className="v3-question-skeleton" key={item}><span /><span /><span /></div>)}</>;
}

function DatabaseUnavailable() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v4c0 1.7 3.6 3 8 3 1 0 2-.1 2.8-.2M18 16l4 4m0-4-4 4" /></svg>;
}
