'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  Search, Loader2, Shield, KeyRound, Wallet, AlertTriangle,
  ChevronLeft, ChevronRight, Check, X,
} from 'lucide-react';
import { adminFetch } from '../lib/fetch';
import { LoadingSpinner, ErrorBox } from './AdminDashboard';
import { useDebouncedValue } from '../../components/useDebouncedValue';

/**
 * Shared-key grants.
 *
 * Bring-your-own-key is the default: a student pays their own provider. This
 * screen manages the single exception — letting one named account spend the
 * owner's server key instead. That is real money leaving the owner's account,
 * so every affordance here states the consequence rather than calling it
 * "access".
 *
 * No secret is displayed or handled. A grant is a boolean; the shared key
 * itself never leaves the server environment.
 */

type AiAccessUser = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  role: string;
  banned: boolean;
  createdAt: string;
  effectiveAdmin: boolean;
  sharedKeyAccess: boolean;
  grantedAt: string | null;
  grantedBy: string | null;
  hasOwnKey: boolean;
  textModel: string | null;
};

type Grant = {
  userId: string;
  name: string | null;
  email: string;
  grantedAt: string | null;
  grantedBy: string | null;
  hasOwnKey: boolean;
};

type AiAccessResponse = {
  sharedKeyConfigured: boolean;
  grants: Grant[];
  users: AiAccessUser[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export default function AiAccessManager() {
  const [data, setData] = useState<AiAccessResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  // Debounced so typing a name fires one request, not one per keystroke.
  const debouncedQ = useDebouncedValue(q, 300);
  const [grantedOnly, setGrantedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<AiAccessUser | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (debouncedQ) params.set('q', debouncedQ);
      if (grantedOnly) params.set('granted', '1');
      params.set('page', String(page));
      const res = await adminFetch<AiAccessResponse>(`/api/admin/ai-access?${params}`);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load AI access');
    } finally {
      setLoading(false);
    }
  }, [debouncedQ, grantedOnly, page]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  const setGrant = async (user: AiAccessUser, granted: boolean) => {
    setActionLoading(user.id);
    setError(null);
    try {
      await adminFetch('/api/admin/ai-access', {
        method: 'POST',
        body: JSON.stringify({ userId: user.id, granted }),
      });
      setConfirming(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the grant');
      setConfirming(null);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <header>
        <h1 className="text-2xl font-bold">AI Access</h1>
        <p className="text-sm text-gray-500 mt-1">
          Who may spend the platform&apos;s shared AI key instead of their own.
        </p>
      </header>

      {error && <ErrorBox message={error} />}

      {/* The consequence, stated once and plainly, above everything else. */}
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4 flex items-start gap-3">
        <Wallet className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-amber-800 dark:text-amber-200 space-y-1">
          <p className="font-semibold">A grant spends your money, not theirs.</p>
          <p className="text-[13px] leading-5">
            Normally every student pays their own AI provider with their own API key.
            Granting shared access means this account&apos;s tutoring, hints, grading, mock
            exams and OCR are billed to the platform owner&apos;s account instead. Granted
            accounts still sit under the monthly per-user spend cap, but that cap is a limit
            on your bill, not a substitute for one. Grant it for demos and for students who
            genuinely cannot obtain a key, then revoke it when they no longer need it.
          </p>
        </div>
      </div>

      {data && !data.sharedKeyConfigured && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700 dark:text-red-300">
            No shared server key is configured (<code>DEEPSEEK_API_KEY</code>), so a grant
            would currently do nothing. Existing grants are listed below and take effect as
            soon as a key is set.
          </p>
        </div>
      )}

      {/* Standing liability: everyone holding a grant right now, regardless of
          the search filter below. */}
      {data && (
        <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
          <div className="flex items-center gap-2 mb-2">
            <KeyRound className="w-4 h-4 text-indigo-500" />
            <h2 className="font-semibold text-sm">
              {data.grants.length === 0
                ? 'Nobody is on the shared key'
                : `${data.grants.length} account${data.grants.length === 1 ? '' : 's'} currently on the shared key`}
            </h2>
          </div>
          {data.grants.length > 0 && (
            <ul className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
              {data.grants.map((g) => (
                <li key={g.userId} className="flex flex-wrap items-center gap-x-2">
                  <span className="font-medium text-gray-700 dark:text-gray-300">
                    {g.name ?? 'Unnamed'}
                  </span>
                  <span>{g.email}</span>
                  {g.grantedAt && <span>· since {new Date(g.grantedAt).toLocaleDateString()}</span>}
                  {g.grantedBy && <span>· by {g.grantedBy}</span>}
                  {g.hasOwnKey && (
                    <span className="text-green-600 dark:text-green-400">
                      · also has their own key (their key is used first, so this grant costs
                      you nothing today)
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            placeholder="Search by name or email"
            aria-label="Search users by name or email"
            className="w-full pl-9 pr-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
          />
        </div>
        <select
          value={grantedOnly ? 'granted' : 'all'}
          onChange={(e) => { setGrantedOnly(e.target.value === 'granted'); setPage(1); }}
          className="px-3 py-2 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded-md text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
        >
          <option value="all">All users</option>
          <option value="granted">On the shared key</option>
        </select>
      </div>

      {/* Only spinner before the first result set — refetching on every
          keystroke otherwise makes the table flash. */}
      {loading && !data ? <LoadingSpinner /> : data && (
        <>
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-800/50 text-gray-500 text-xs uppercase">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">User</th>
                    <th className="text-left px-4 py-3 font-medium">Pays for AI with</th>
                    <th className="text-left px-4 py-3 font-medium">Grant</th>
                    <th className="text-right px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {data.users.map((u) => (
                    <tr key={u.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <Avatar name={u.name} image={u.image} />
                          <div className="min-w-0">
                            <p className="font-medium truncate flex items-center gap-1.5">
                              {u.name ?? 'Unnamed'}
                              {u.effectiveAdmin && <Shield className="w-3.5 h-3.5 text-indigo-500" />}
                              {u.banned && <span className="text-[10px] text-red-600 font-medium">BANNED</span>}
                            </p>
                            <p className="text-xs text-gray-400 truncate">{u.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <PaysWith user={u} />
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {u.sharedKeyAccess ? (
                          <>
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 font-medium">
                              <Wallet className="w-3 h-3" /> Billed to you
                            </span>
                            <span className="block mt-1 text-gray-400">
                              {u.grantedAt ? new Date(u.grantedAt).toLocaleDateString() : 'date unknown'}
                              {u.grantedBy ? ` · by ${u.grantedBy}` : ''}
                            </span>
                          </>
                        ) : (
                          <span className="text-gray-400">None</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end">
                          {u.sharedKeyAccess ? (
                            <button
                              onClick={() => setGrant(u, false)}
                              disabled={actionLoading === u.id}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-red-600 border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {actionLoading === u.id
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                : <X className="w-3.5 h-3.5" />}
                              Revoke
                            </button>
                          ) : (
                            <button
                              onClick={() => setConfirming(u)}
                              disabled={actionLoading === u.id}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <Wallet className="w-3.5 h-3.5" />
                              Grant at your expense
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {data.users.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-400">
                        No users match this search.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-500">
              {data.users.length} of {data.total} users · Page {data.page} of {data.totalPages}
            </p>
            <div className="flex gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                aria-label="Previous page"
                className="p-2 rounded-md border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-30"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                disabled={page >= data.totalPages}
                aria-label="Next page"
                className="p-2 rounded-md border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-30"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </>
      )}

      {/* Granting is the direction that costs money, so it is the direction
          that gets a confirmation. Revoking is immediate. */}
      {confirming && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="grant-confirm-title"
        >
          <div className="bg-white dark:bg-gray-900 rounded-lg max-w-md w-full p-6">
            <div className="flex items-start justify-between mb-3">
              <h3 id="grant-confirm-title" className="font-bold flex items-center gap-2">
                <Wallet className="w-5 h-5 text-amber-600" />
                Bill this student&apos;s AI to you?
              </h3>
              <button
                onClick={() => setConfirming(null)}
                aria-label="Cancel"
                className="p-1 text-gray-400 hover:text-gray-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              <span className="font-medium">{confirming.name ?? 'This account'}</span>{' '}
              ({confirming.email}) will be able to use the platform&apos;s shared AI key.
              Every request they make — tutoring, hints, grading, mock exams — is charged to
              the platform owner&apos;s provider account, up to the monthly per-user cap.
            </p>
            {confirming.hasOwnKey && (
              <p className="mt-3 text-xs text-green-700 dark:text-green-400">
                They already have their own key saved. Their own key is always used first, so
                this grant only starts costing you if they delete it.
              </p>
            )}
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setConfirming(null)}
                className="flex-1 py-2.5 rounded-md border border-gray-200 dark:border-gray-700 text-sm font-medium hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={() => setGrant(confirming, true)}
                disabled={actionLoading === confirming.id}
                className="flex-1 inline-flex items-center justify-center gap-2 py-2.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold disabled:opacity-50"
              >
                {actionLoading === confirming.id
                  ? <Loader2 className="w-4 h-4 animate-spin" />
                  : <Check className="w-4 h-4" />}
                Grant
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Which wallet this account's AI comes out of today. The resolution order is
 * own key first, then a grant, so a student with both costs the owner nothing.
 */
function PaysWith({ user }: { user: AiAccessUser }) {
  if (user.hasOwnKey) {
    return (
      <div className="text-xs">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-200 font-medium">
          <KeyRound className="w-3 h-3" /> Their own key
        </span>
        {user.textModel && <span className="block mt-1 text-gray-400 truncate">{user.textModel}</span>}
      </div>
    );
  }
  if (user.sharedKeyAccess) {
    return (
      <span className="text-xs inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 font-medium">
        <Wallet className="w-3 h-3" /> Your shared key
      </span>
    );
  }
  return <span className="text-xs text-gray-400">AI switched off</span>;
}

function Avatar({ name, image }: { name: string | null; image: string | null }) {
  if (image) return <img src={image} alt="" className="w-8 h-8 rounded-full object-cover" />;
  return (
    <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
      {name?.[0]?.toUpperCase() ?? '?'}
    </div>
  );
}
