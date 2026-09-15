'use client';

import { useEffect, useState } from 'react';
import { Users, FileText, MessageSquare, DollarSign, Activity, TrendingUp, Megaphone } from 'lucide-react';
import { adminFetch } from '../lib/fetch';

type Stats = {
  users: { total: number; new7d: number; new30d: number; banned: number };
  content: { threads: number; posts: number; schoolResources: number; mockExams: number; pastPaperAttempts: number; notebooks: number };
  announcements: { total: number; active: number };
  ai: { totalCost: number; totalRequests: number; cost30d: number; requests30d: number };
  charts: {
    signupsByDay: { date: string; count: number }[];
    usageByFeature: { feature: string; cost: number; requests: number }[];
    roleDistribution: { role: string; count: number }[];
  };
};

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch<Stats>('/api/admin/stats')
      .then(setStats)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorBox message={error} />;
  if (!stats) return null;

  const maxSignup = Math.max(1, ...stats.charts.signupsByDay.map((s) => s.count));
  const maxUsage = Math.max(1, ...stats.charts.usageByFeature.map((u) => u.cost));

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <header>
        <h1 className="text-2xl font-bold">Platform Overview</h1>
        <p className="text-sm text-muted mt-1">Real-time snapshot of your platform&apos;s health.</p>
      </header>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard icon={Users} label="Total Users" value={stats.users.total.toLocaleString()} sub={`+${stats.users.new7d} this week`} />
        <KpiCard icon={MessageSquare} label="Content Items" value={(stats.content.threads + stats.content.posts + stats.content.schoolResources).toLocaleString()} sub={`${stats.content.threads} threads`} />
        <KpiCard icon={Activity} label="AI Requests" value={stats.ai.totalRequests.toLocaleString()} sub={`$${stats.ai.totalCost.toFixed(4)} total`} />
        <KpiCard icon={Megaphone} label="Active Announcements" value={stats.announcements.active.toLocaleString()} sub={`${stats.announcements.total} total`} />
      </div>

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Signups chart */}
        <ChartCard title="User Signups (14 days)">
          <div className="flex items-end gap-1.5 h-40">
            {stats.charts.signupsByDay.map((s) => (
              // `h-full` is load-bearing, the same way it is on /usage: the bar
              // below sets a percentage height, and a percentage against an
              // auto-height parent resolves to nothing. The `h-40` is on the
              // row, not the column, so every bar fell back to its 4px minimum
              // and a fortnight of signups drew as a row of ticks.
              <div key={s.date} className="flex h-full flex-1 flex-col items-center justify-end gap-1 group">
                <div
                  className="w-full bg-accent rounded-t-sm hover:bg-accent-hover transition-colors"
                  style={{ height: `${(s.count / maxSignup) * 100}%`, minHeight: s.count > 0 ? '4px' : '0' }}
                  title={`${s.date}: ${s.count}`}
                />
                <span className="text-[9px] text-muted -rotate-45 origin-center whitespace-nowrap">{s.date}</span>
              </div>
            ))}
          </div>
        </ChartCard>

        {/* AI cost by feature */}
        <ChartCard title="AI Cost by Feature (30d)">
          {stats.charts.usageByFeature.length === 0 ? (
            <Empty />
          ) : (
            <div className="space-y-2">
              {stats.charts.usageByFeature.map((u) => (
                <div key={u.feature} className="flex items-center gap-3">
                  <span className="text-xs w-32 truncate text-secondary">{u.feature}</span>
                  <div className="flex-1 bg-surface-raised rounded-full h-5 overflow-hidden">
                    <div
                      className="h-full bg-warning rounded-full flex items-center justify-end pr-2"
                      style={{ width: `${Math.max(2, (u.cost / maxUsage) * 100)}%` }}
                    >
                      <span className="text-[10px] text-white font-medium">${u.cost.toFixed(3)}</span>
                    </div>
                  </div>
                  <span className="text-xs text-muted w-16 text-right">{u.requests} req</span>
                </div>
              ))}
            </div>
          )}
        </ChartCard>
      </div>

      {/* Detailed breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <InfoCard title="Content Breakdown">
          <StatRow icon={MessageSquare} label="Discussion Threads" value={stats.content.threads} />
          <StatRow icon={MessageSquare} label="Discussion Posts" value={stats.content.posts} />
          <StatRow icon={FileText} label="School Resources" value={stats.content.schoolResources} />
          <StatRow icon={Activity} label="Mock Exams" value={stats.content.mockExams} />
          <StatRow icon={TrendingUp} label="Past-Paper Attempts" value={stats.content.pastPaperAttempts} />
          <StatRow icon={FileText} label="Notebooks" value={stats.content.notebooks} />
        </InfoCard>

        <InfoCard title="User Roles">
          {stats.charts.roleDistribution.length === 0 ? (
            <Empty />
          ) : (
            stats.charts.roleDistribution.map((r) => (
              <StatRow key={r.role} label={r.role} value={r.count} />
            ))
          )}
          <div className="pt-2 mt-2 border-t border-subtle">
            <StatRow label="Banned" value={stats.users.banned} />
          </div>
        </InfoCard>

        <InfoCard title="AI Usage">
          <StatRow icon={DollarSign} label="Total Cost" value={`$${stats.ai.totalCost.toFixed(4)}`} />
          <StatRow icon={Activity} label="Total Requests" value={stats.ai.totalRequests} />
          <StatRow label="Cost (30d)" value={`$${stats.ai.cost30d.toFixed(4)}`} />
          <StatRow label="Requests (30d)" value={stats.ai.requests30d} />
        </InfoCard>
      </div>
    </div>
  );
}

/* ---------------- shared bits ---------------- */

function KpiCard({ icon: Icon, label, value, sub }: { icon: typeof Users; label: string; value: string; sub: string }) {
  return (
    <div className="bg-surface rounded-lg border border-line p-4">
      <div className={`w-10 h-10 rounded-md bg-surface-raised flex items-center justify-center mb-3`}>
        <Icon className="w-5 h-5 text-secondary" />
      </div>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-xs text-muted mt-0.5">{label}</p>
      <p className="text-[10px] text-muted mt-1">{sub}</p>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface rounded-lg border border-line p-5">
      <h3 className="text-sm font-semibold mb-4">{title}</h3>
      {children}
    </div>
  );
}

function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface rounded-lg border border-line p-5">
      <h3 className="text-sm font-semibold mb-3">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function StatRow({ icon: Icon, label, value }: { icon?: typeof Users; label: string; value: number | string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="flex items-center gap-2 text-secondary">
        {Icon && <Icon className="w-3.5 h-3.5" />}
        {label}
      </span>
      <span className="font-medium">{typeof value === 'number' ? value.toLocaleString() : value}</span>
    </div>
  );
}

function Empty() {
  return <p className="text-sm text-muted italic py-4 text-center">No data</p>;
}

export function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="w-8 h-8 border-2 border-line border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className="bg-danger-subtle border border-danger-border rounded-lg p-4 text-sm text-danger">
      <p className="font-medium">Error</p>
      <p className="mt-1">{message}</p>
    </div>
  );
}
