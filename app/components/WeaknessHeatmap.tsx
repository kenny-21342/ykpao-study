'use client';

import { useState, useEffect } from 'react';
import {
  Loader2, Target, AlertTriangle, TrendingDown, Flame, ChevronRight,
  BarChart3,
} from 'lucide-react';

import { groupTopicsBySubject, type TopicRow } from '@/lib/weakness-grouping';


type SubjectRow = {
  subject: string;
  total: number;
  correct: number;
  accuracy: number;
};


type Recommended = {
  id: number;
  topic: string;
  subject: string;
  content: string;
  marks: number;
};

type WeaknessData = {
  topics: TopicRow[];
  subjects: SubjectRow[];
  recommended: Recommended[];
  totalAttempts?: number;
  sources?: {
    pastPaper: number;
    mockExams: number;
    legacyQuestions: number;
  };
  message?: string;
};

// Colour band for the heatmap cell, based on accuracy 0–100.
function bandFor(acc: number): { bg: string; text: string; label: string } {
  if (acc >= 85) return { bg: 'bg-band-5', text: 'text-inverse', label: 'Mastered' };
  if (acc >= 70) return { bg: 'bg-band-4', text: 'text-inverse', label: 'Strong' };
  if (acc >= 55) return { bg: 'bg-band-3', text: 'text-inverse', label: 'OK' };
  if (acc >= 40) return { bg: 'bg-band-2', text: 'text-inverse', label: 'Weak' };
  return { bg: 'bg-band-1', text: 'text-inverse', label: 'Critical' };
}


export default function WeaknessHeatmap() {
  const [data, setData] = useState<WeaknessData | null>(null);
  const [loading, setLoading] = useState(true);
  const [practicing, setPracticing] = useState(false);
  const [collapsedSubjects, setCollapsedSubjects] = useState<Set<string>>(new Set());
  const toggleSubject = (subject: string) =>
    setCollapsedSubjects((current) => {
      const next = new Set(current);
      if (next.has(subject)) next.delete(subject);
      else next.add(subject);
      return next;
    });

  useEffect(() => {
    let cancelled = false;

    async function loadWeaknesses() {
      try {
        const res = await fetch('/api/weaknesses?limit=10');
        if (!cancelled && res.ok) setData(await res.json());
      } catch {
        // best-effort
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadWeaknesses();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Open the weakest recommended question in the practice browser.
   *
   * This used to write the whole recommended list to `sessionStorage` under
   * `weakness-queue` and dispatch a bare event, and **nothing anywhere read
   * either one** -- the component was imported by no file at all, so the
   * button had never been pressed. Serving the list as an ordered queue needs
   * next/previous UI the practice browser does not have, so rather than leave
   * a promise nothing keeps, the event now carries the first id and opens it.
   * The stored queue is gone: an unread key that looks like state is worse
   * than no key.
   */
  const practiceWeak = () => {
    const first = data?.recommended[0];
    if (!first) return;
    setPracticing(true);
    window.dispatchEvent(
      new CustomEvent('open-weakness-practice', { detail: { questionId: first.id } }),
    );
    setPracticing(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-accent-text" />
      </div>
    );
  }

  if (!data || data.topics.length === 0) {
    return (
      <div className="bg-surface rounded-lg p-12 border border-line text-center">
        <div className="w-16 h-16 mx-auto rounded-full bg-surface-raised flex items-center justify-center mb-3">
          <Target className="w-8 h-8 text-muted" />
        </div>
        <h4 className="font-bold text-primary">No data yet</h4>
        <p className="text-sm text-muted mt-1 max-w-md mx-auto">
          {data?.message ?? 'Answer a few questions to see your strengths and weaknesses.'}
        </p>
      </div>
    );
  }

  const grouped = groupTopicsBySubject(data.topics);

  const sourceSummary = data.sources
    ? [
        data.sources.pastPaper ? `${data.sources.pastPaper} practice answers` : null,
        data.sources.mockExams ? `${data.sources.mockExams} mock-exam items` : null,
        data.sources.legacyQuestions ? `${data.sources.legacyQuestions} legacy question attempts` : null,
      ].filter(Boolean).join(' · ')
    : '';

  return (
    <div className="space-y-6">
      {/* Header / CTA */}
      <div className="bg-warning-subtle rounded-lg p-6 border border-warning-border">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-primary flex items-center gap-2">
              <Flame className="w-5 h-5 text-warning" />
              Focus Areas
            </h3>
            <p className="text-sm text-secondary mt-1">
              Based on {data.totalAttempts ?? 0} graded attempts.
              {sourceSummary ? ` Sources: ${sourceSummary}.` : ' Your weakest topics need the most attention.'}
            </p>
          </div>
          <button
            onClick={practiceWeak}
            disabled={data.recommended.length === 0 || practicing}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-danger text-white rounded-lg font-semibold disabled:opacity-60 transition-all"
          >
            <Target className="w-4 h-4" />
            Practice Weakest ({data.recommended.length})
          </button>
        </div>
      </div>

      {/* Subject overview */}
      <div className="bg-surface rounded-lg p-6 border border-line">
        <h4 className="font-bold text-primary mb-4 flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-accent-text" />
          By Subject
        </h4>
        <div className="space-y-3">
          {data.subjects.map((s) => {
            const band = bandFor(s.accuracy);
            return (
              <div key={s.subject} className="flex items-center gap-3">
                <div className="w-32 text-sm font-medium text-secondary truncate">
                  {s.subject}
                </div>
                <div className="flex-1 h-6 bg-surface-raised rounded-md overflow-hidden relative">
                  <div
                    className={`h-full ${band.bg} ${band.text} flex items-center justify-end pr-2 text-xs font-semibold transition-all duration-500`}
                    style={{ width: `${Math.max(8, s.accuracy)}%` }}
                  >
                    {s.accuracy}%
                  </div>
                </div>
                <div className="w-20 text-xs text-muted text-right">
                  {s.correct}/{s.total}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Topic heatmap */}
      <div className="bg-surface rounded-lg p-6 border border-line">
        <div className="flex items-center justify-between mb-4">
          <h4 className="font-bold text-primary flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-warning" />
            Topic Mastery Heatmap
          </h4>
          <div className="hidden sm:flex items-center gap-2 text-[10px] text-muted">
            <span className="px-1.5 py-0.5 rounded-sm bg-band-1 text-inverse">Critical</span>
            <span className="px-1.5 py-0.5 rounded-sm bg-band-2 text-inverse">Weak</span>
            <span className="px-1.5 py-0.5 rounded-sm bg-band-3 text-inverse">OK</span>
            <span className="px-1.5 py-0.5 rounded-sm bg-band-4 text-inverse">Strong</span>
            <span className="px-1.5 py-0.5 rounded-sm bg-band-5 text-inverse">Mastered</span>
          </div>
        </div>

        {/* Grouped by subject rather than one flat grid. The API sorts topics
          * worst-first, but a student with a full timetable has 140+ of them
          * and most share an accuracy, so the ties made the order look
          * arbitrary and the only clue to which subject a tile belonged was
          * its tooltip. Each subject is now its own labelled, collapsible
          * block, still weakest-first inside and between. */}
        <div className="space-y-4">
          {grouped.map((group) => {
            const collapsed = collapsedSubjects.has(group.subject);
            const band = bandFor(group.accuracy);
            return (
              <div key={group.subject}>
                <button
                  type="button"
                  onClick={() => toggleSubject(group.subject)}
                  aria-expanded={!collapsed}
                  className="mb-2 flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-surface-hover"
                >
                  <ChevronRight
                    className={`h-4 w-4 flex-none text-muted transition-transform ${collapsed ? '' : 'rotate-90'}`}
                  />
                  <span className="text-sm font-bold text-primary">{group.subject}</span>
                  <span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-bold ${band.bg} ${band.text}`}>
                    {group.accuracy}%
                  </span>
                  <span className="text-xs text-muted">
                    {group.topics.length} {group.topics.length === 1 ? 'topic' : 'topics'}
                  </span>
                </button>
                {!collapsed && (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {group.topics.map((t) => {
                      const topicBand = bandFor(t.accuracy);
                      return (
                        <div
                          key={t.key}
                          className={`rounded-lg p-3 ${topicBand.bg} ${topicBand.text} transition-transform hover:scale-[1.03] cursor-default`}
                          title={`${t.subject} · ${t.topic} — ${t.accuracy}% (${t.correct}/${t.total})`}
                        >
                          <p className="text-[11px] font-medium opacity-90 truncate">{t.topic}</p>
                          <p className="text-lg font-bold mt-0.5">{t.accuracy}%</p>
                          <p className="text-[10px] opacity-80">{t.total} attempts</p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Recommended questions */}
      {data.recommended.length > 0 && (
        <div className="bg-surface rounded-lg p-6 border border-line">
          <h4 className="font-bold text-primary mb-4 flex items-center gap-2">
            <TrendingDown className="w-4 h-4 text-danger" />
            Recommended for Practice
          </h4>
          <ul className="divide-y divide-subtle">
            {data.recommended.map((q) => (
              <li
                key={q.id}
                className="py-3 flex items-start gap-3 cursor-pointer hover:bg-surface-hover -mx-2 px-2 rounded-md transition-colors"
                onClick={practiceWeak}
              >
                <ChevronRight className="w-4 h-4 text-muted mt-1 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-muted">
                    {q.subject} · {q.topic}
                    {q.marks > 0 && <> · {q.marks} marks</>}
                  </p>
                  <p className="text-sm text-primary line-clamp-2 mt-0.5">
                    {q.content}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
