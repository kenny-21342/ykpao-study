'use client';

import { useEffect, useState } from 'react';
import { Activity, DollarSign, HardDrive, Cpu, AlertTriangle } from 'lucide-react';
import { adminFetch } from '../lib/fetch';
import { LoadingSpinner, ErrorBox } from './AdminDashboard';

type SystemData = {
  ai: {
    byModel: { model: string; cost: number; tokensIn: number; tokensOut: number; requests: number }[];
    byFeature: { feature: string; cost: number; requests: number }[];
    errors24h: number;
    requests24h: number;
    totalCost: number;
    cost7d: number;
    topUsers: { email: string; name: string | null; cost: number; requests: number }[];
  };
  // largestFiles is optional on purpose: this type is an unchecked cast over
  // the network, so anything declared required here is a promise the server is
  // not held to. It was declared required and never sent, which crashed the
  // whole console on a `.length` read.
  storage: {
    totalBytes: number;
    totalMB: number;
    largestFiles?: { title: string; fileName: string; fileSize: number }[];
  };
  tables: { name: string; count: number }[];
};

export default function SystemMonitor() {
  const [data, setData] = useState<SystemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminFetch<SystemData>('/api/admin/system')
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorBox message={error} />;
  if (!data) return null;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <header>
        <h1 className="text-2xl font-bold">System Health</h1>
        <p className="text-sm text-gray-500 mt-1">AI usage, storage, and database metrics.</p>
      </header>

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Metric icon={DollarSign} label="Total AI Cost" value={`$${data.ai.totalCost.toFixed(4)}`} sub={`$${data.ai.cost7d.toFixed(4)} (7d)`} />
        <Metric icon={Activity} label="AI Requests (24h)" value={data.ai.requests24h.toLocaleString()} sub={`${data.ai.byModel.length} models`} />
        <Metric icon={HardDrive} label="Storage Used" value={`${data.storage.totalMB} MB`} sub={`${data.tables.reduce((s, t) => s + t.count, 0).toLocaleString()} records`} />
        <Metric icon={AlertTriangle} label="Errors (24h)" value={data.ai.errors24h.toString()} sub="AI failures" />
      </div>

      {/* AI by model */}
      <Card title="AI Usage by Model" icon={Cpu}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 uppercase">
              <tr>
                <th className="text-left py-2 font-medium">Model</th>
                <th className="text-right py-2 font-medium">Requests</th>
                <th className="text-right py-2 font-medium">Tokens In</th>
                <th className="text-right py-2 font-medium">Tokens Out</th>
                <th className="text-right py-2 font-medium">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {data.ai.byModel.map((m) => (
                <tr key={m.model}>
                  <td className="py-2 font-mono text-xs">{m.model || '(default)'}</td>
                  <td className="py-2 text-right">{m.requests.toLocaleString()}</td>
                  <td className="py-2 text-right text-gray-500">{m.tokensIn.toLocaleString()}</td>
                  <td className="py-2 text-right text-gray-500">{m.tokensOut.toLocaleString()}</td>
                  <td className="py-2 text-right font-medium">${m.cost.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Top users by cost */}
      <Card title="Top Users by AI Cost" icon={DollarSign}>
        {data.ai.topUsers.length === 0 ? (
          <p className="text-sm text-gray-400 italic py-4 text-center">No usage recorded.</p>
        ) : (
          <div className="space-y-2">
            {data.ai.topUsers.map((u, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="truncate">
                  <span className="text-gray-400 mr-2">#{i + 1}</span>
                  {u.name ?? u.email}
                </span>
                <span className="font-medium ml-2">${u.cost.toFixed(4)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Database tables */}
      <Card title="Database Record Counts" icon={HardDrive}>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {data.tables.map((t) => (
            <div key={t.name} className="flex items-center justify-between bg-gray-50 dark:bg-gray-800/50 rounded-md px-3 py-2">
              <span className="text-xs text-gray-600 dark:text-gray-400 truncate">{t.name}</span>
              <span className="text-sm font-medium ml-2">{t.count.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Largest files */}
      {(data.storage.largestFiles?.length ?? 0) > 0 && (
        <Card title="Largest Files" icon={HardDrive}>
          <div className="space-y-2">
            {data.storage.largestFiles!.map((f, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <span className="truncate">{f.title || f.fileName}</span>
                <span className="text-gray-500 ml-2 flex-shrink-0">{(f.fileSize / 1024 / 1024).toFixed(1)} MB</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function Metric({ icon: Icon, label, value, sub }: { icon: typeof DollarSign; label: string; value: string; sub: string }) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
      <div className={`w-9 h-9 rounded-md bg-surface-raised flex items-center justify-center mb-3`}>
        <Icon className="w-4 h-4 text-secondary" />
      </div>
      <p className="text-xl font-bold">{value}</p>
      <p className="text-xs text-gray-500 mt-0.5">{label}</p>
      <p className="text-[10px] text-gray-400 mt-1">{sub}</p>
    </div>
  );
}

function Card({ title, icon: Icon, children }: { title: string; icon: typeof DollarSign; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-5">
      <h3 className="text-sm font-semibold mb-4 flex items-center gap-2"><Icon className="w-4 h-4 text-gray-400" /> {title}</h3>
      {children}
    </div>
  );
}
