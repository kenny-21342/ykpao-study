'use client';

import { useState, useEffect, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, Loader2, AlertCircle, Zap, DollarSign, Cpu, TrendingUp,
  Sparkles, ClipboardCheck, FileQuestion, MessageSquare,
} from 'lucide-react';

type UsageData = {
  totals: {
    totalTokensIn: number;
    totalTokensOut: number;
    totalCost: number;
    totalRequests: number;
  };
  byFeature: Record<string, { count: number; tokens: number; cost: number }>;
  byDay: Record<string, { tokens: number; cost: number; count: number }>;
  recent: Array<{
    id: string;
    feature: string;
    tokensIn: number;
    tokensOut: number;
    cost: number;
    model: string;
    createdAt: string;
  }>;
};

const FEATURE_ICONS: Record<string, { icon: React.ReactNode; label: string }> = {
  'ai-chat': { icon: <MessageSquare className="w-4 h-4" />, label: 'AI Chat' },
  'mock-exam-generate': { icon: <Sparkles className="w-4 h-4" />, label: 'Mock Exam Generation' },
  'mock-exam-grade': { icon: <ClipboardCheck className="w-4 h-4" />, label: 'Mock Exam Grading' },
  'practice-grade': { icon: <FileQuestion className="w-4 h-4" />, label: 'Practice Grading' },
};

/**
 * A readable name for a feature the map above has never heard of.
 *
 * The map covers four features and the app records a dozen -- vision grading,
 * OCR, RAG chat, hints, and an `:error` variant of most of them -- so the list
 * read as a mix of "Mock Exam Grading" and `mock-exam-grade-vision`. Deriving
 * the label means a feature added later is legible the day it ships instead of
 * the day someone remembers this map exists.
 */
function featureLabel(feature: string): string {
  const [name, variant] = feature.split(':');
  const words = name
    .split('-')
    .map((word) => (word === 'ai' || word === 'ocr' || word === 'rag' ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
  return variant ? `${words} (${variant})` : words;
}

export default function UsagePage() {
  const { status } = useSession();
  const router = useRouter();
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/usage');
      if (!res.ok) throw new Error('Failed to load usage');
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === 'unauthenticated') router.push('/auth/login');
    if (status !== 'authenticated') return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [status, load, router]);

  if (status === 'loading' || loading) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="min-h-full flex items-center justify-center p-8">
        <div className="bg-danger-subtle border border-danger-border rounded-lg p-5 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-danger" />
          <p className="text-sm text-danger">{error}</p>
        </div>
      </div>
    );
  }
  if (!data) return null;

  const fmtNum = (n: number) => n.toLocaleString();
  const fmtCost = (n: number) => `$${n.toFixed(4)}`;
  const dayEntries = Object.entries(data.byDay).sort();

  return (
    <div className="min-h-full bg-canvas p-4 md:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="p-2 text-muted hover:text-secondary hover:bg-surface-hover rounded-md transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <h1 className="text-2xl font-bold text-primary">Usage & API Credits</h1>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <SummaryCard icon={<Zap className="w-5 h-5" />} label="API Requests" value={fmtNum(data.totals.totalRequests)} tint="blue" />
          <SummaryCard icon={<Cpu className="w-5 h-5" />} label="Total Tokens" value={fmtNum(data.totals.totalTokensIn + data.totals.totalTokensOut)} tint="green" />
          <SummaryCard icon={<TrendingUp className="w-5 h-5" />} label="Tokens In" value={fmtNum(data.totals.totalTokensIn)} tint="amber" />
          <SummaryCard icon={<DollarSign className="w-5 h-5" />} label="Est. Cost" value={fmtCost(data.totals.totalCost)} tint="purple" />
        </div>

        {/* Breakdown by feature */}
        <div className="bg-surface rounded-lg border border-line p-6">
          <h2 className="text-lg font-bold text-primary mb-4">By Feature</h2>
          {Object.keys(data.byFeature).length === 0 ? (
            <p className="text-sm text-muted">No usage recorded yet. Try the AI Chat, Mock Exams, or Practice features!</p>
          ) : (
            <div className="space-y-3">
              {Object.entries(data.byFeature).map(([key, val]) => {
                const meta = FEATURE_ICONS[key] ?? { icon: <Zap className="w-4 h-4" />, label: featureLabel(key) };
                return (
                  <div key={key} className="flex items-center gap-4 p-3 bg-surface-raised rounded-lg">
                    <div className="w-10 h-10 rounded-md bg-accent-subtle text-accent-text flex items-center justify-center flex-shrink-0">
                      {meta.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-primary">{meta.label}</p>
                      <p className="text-xs text-muted">{fmtNum(val.tokens)} tokens</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-primary">{val.count} calls</p>
                      <p className="text-xs text-muted">{fmtCost(val.cost)}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Last 7 days */}
        <div className="bg-surface rounded-lg border border-line p-6">
          <h2 className="text-lg font-bold text-primary mb-4">Last 7 Days</h2>
          {dayEntries.length === 0 ? (
            <p className="text-sm text-muted">No activity this week.</p>
          ) : (
            <div className="flex items-end gap-2 h-32">
              {dayEntries.map(([day, val]) => {
                const maxTokens = Math.max(...dayEntries.map(([, v]) => v.tokens), 1);
                const heightPct = (val.tokens / maxTokens) * 100;
                return (
                  // `h-full` is load-bearing: the bar's height is a
                  // percentage, and a percentage against an auto-height parent
                  // resolves to nothing. Every bar collapsed to its 4px
                  // minimum, so a week of usage drew as a flat line.
                  <div key={day} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
                    <div className="text-xs text-muted font-mono">{val.tokens > 999 ? `${(val.tokens / 1000).toFixed(1)}k` : val.tokens}</div>
                    <div
                      className="w-full bg-accent rounded-t-md min-h-[4px]"
                      style={{ height: `${Math.max(heightPct, 3)}%` }}
                    />
                    <div className="text-xs text-muted">
                      {new Date(day).toLocaleDateString(undefined, { weekday: 'short' })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Recent log */}
        <div className="bg-surface rounded-lg border border-line p-6">
          <h2 className="text-lg font-bold text-primary mb-4">Recent Requests</h2>
          {data.recent.length === 0 ? (
            <p className="text-sm text-muted">No recent activity.</p>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {data.recent.map((r) => {
                const meta = FEATURE_ICONS[r.feature] ?? { icon: <Zap className="w-3.5 h-3.5" />, label: featureLabel(r.feature) };
                return (
                  <div key={r.id} className="flex items-center gap-3 py-2 border-b border-subtle last:border-0">
                    <span className="text-muted">{meta.icon}</span>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-secondary">{meta.label}</span>
                      <span className="text-xs text-muted ml-2">
                        {(r.tokensIn + r.tokensOut).toLocaleString()} tokens · {r.model}
                      </span>
                    </div>
                    <span className="text-xs text-muted flex-shrink-0">
                      {new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                    <span className="text-xs font-medium text-secondary w-12 text-right">
                      {fmtCost(r.cost)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryCard({ icon, label, value, tint }: { icon: React.ReactNode; label: string; value: string; tint: 'blue' | 'green' | 'amber' | 'purple' }) {
  const tints: Record<string, string> = {
    blue: 'bg-surface-raised text-secondary',
    green: 'bg-accent-subtle text-accent-text',
    amber: 'bg-warning-subtle text-warning',
    purple: 'bg-surface-raised text-secondary',
  };
  return (
    <div className="bg-surface rounded-lg border border-line p-4">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-3 ${tints[tint]}`}>
        {icon}
      </div>
      <p className="text-2xl font-bold text-primary">{value}</p>
      <p className="text-xs text-muted mt-0.5">{label}</p>
    </div>
  );
}
