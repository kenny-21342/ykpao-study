'use client';

import { useCallback, useEffect, useState } from 'react';
import { Search, Ban, CheckCircle, Trash2, Shield, Loader2, ChevronLeft, ChevronRight, X, KeyRound, Copy, MailCheck, MailX } from 'lucide-react';
import { adminFetch } from '../lib/fetch';
import { LoadingSpinner, ErrorBox } from './AdminDashboard';
import { useDebouncedValue } from '../../components/useDebouncedValue';
import { useConfirm } from '../../components/useConfirm';

type AdminUser = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  role: string;
  banned: boolean;
  bannedReason: string | null;
  createdAt: string;
  onboardedAt: string | null;
  /** Timestamp, not a flag — null means the signup gate still blocks sign-in. */
  emailVerified: string | null;
  effectiveAdmin: boolean;
  _count: {
    notes: number; threads: number; posts: number;
    mockExams: number; pastPaperAttempts: number; usageRecords: number; schoolResources: number;
  };
};

type UsersResponse = { users: AdminUser[]; total: number; page: number; pageSize: number; totalPages: number };

export default function UserManagement() {
  const { confirm, confirmDialog } = useConfirm();
  const [data, setData] = useState<UsersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  // Debounced so typing a query fires one request, not one per keystroke.
  const debouncedQ = useDebouncedValue(q, 300);
  const [roleFilter, setRoleFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [detailUser, setDetailUser] = useState<AdminUser | null>(null);
  // Held only long enough for the admin to copy it; never persisted anywhere.
  const [tempPassword, setTempPassword] = useState<{ email: string; password: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (debouncedQ) params.set('q', debouncedQ);
      if (roleFilter !== 'all') params.set('role', roleFilter);
      params.set('page', String(page));
      const res = await adminFetch<UsersResponse>(`/api/admin/users?${params}`);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [debouncedQ, roleFilter, page]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  const updateRole = async (userId: string, role: string) => {
    setActionLoading(userId);
    try {
      await adminFetch('/api/admin/users', { method: 'PATCH', body: JSON.stringify({ userId, role }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setActionLoading(null);
    }
  };

  const toggleBan = async (user: AdminUser) => {
    setActionLoading(user.id);
    try {
      await adminFetch('/api/admin/users', {
        method: 'PATCH',
        body: JSON.stringify({ userId: user.id, banned: !user.banned, bannedReason: user.banned ? null : 'Banned by admin' }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setActionLoading(null);
    }
  };

  /**
   * The manual way past the signup verification gate.
   *
   * Confirmed rather than immediate in both directions: granting it asserts
   * the address belongs to the person asking, which is the whole thing
   * verification was there to establish, and revoking it locks someone out of
   * a working account.
   */
  const toggleVerified = async (user: AdminUser) => {
    const verified = Boolean(user.emailVerified);
    const ok = await confirm({
      title: verified ? 'Remove this verification?' : 'Mark this address verified?',
      message: verified ? (
        <>
          <p>
            <span className="font-semibold">{user.email}</span> will be blocked at sign-in
            until they confirm the address again. Any session they already have stays live
            until it expires.
          </p>
        </>
      ) : (
        <>
          <p>
            <span className="font-semibold">{user.email}</span> will be able to sign in
            without clicking a confirmation link.
          </p>
          <p className="mt-2">
            Only do this once you know the address reaches the person asking — confirming it
            for them is exactly the check you are skipping.
          </p>
        </>
      ),
      confirmLabel: verified ? 'Remove verification' : 'Mark verified',
      destructive: verified,
    });
    if (!ok) return;

    setActionLoading(user.id);
    try {
      await adminFetch('/api/admin/users', {
        method: 'PATCH',
        body: JSON.stringify({ userId: user.id, emailVerified: !verified }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setActionLoading(null);
    }
  };

  const resetPassword = async (user: AdminUser) => {
    const ok = await confirm({
      title: 'Reset this password?',
      message: (
        <>
          <p>
            <span className="font-semibold">{user.email}</span> will be signed out of every
            device immediately, and their current password stops working.
          </p>
          <p className="mt-2">
            You will be shown a temporary password once, to pass on to them.
          </p>
        </>
      ),
      confirmLabel: 'Reset password',
    });
    if (!ok) return;
    setActionLoading(user.id);
    try {
      const res = await adminFetch<{ temporaryPassword: string; email: string }>(
        '/api/admin/users/reset-password',
        { method: 'POST', body: JSON.stringify({ userId: user.id }) },
      );
      // Shown once — the server only ever stores the hash.
      setTempPassword({ email: res.email, password: res.temporaryPassword });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Password reset failed');
    } finally {
      setActionLoading(null);
    }
  };

  const deleteUser = async (user: AdminUser) => {
    const ok = await confirm({
      title: 'Permanently delete this account?',
      message: (
        <>
          <p>
            <span className="font-semibold">{user.email}</span> and everything they have
            made will be removed for good: notes, attempts, marks, drawings, uploads and
            posts.
          </p>
          <p className="mt-2">This cannot be undone. Consider suspending the account instead.</p>
        </>
      ),
      confirmLabel: 'Delete permanently',
    });
    if (!ok) return;
    setActionLoading(user.id);
    try {
      await adminFetch(`/api/admin/users?userId=${user.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {confirmDialog}
      <header>
        <h1 className="text-2xl font-bold">User Management</h1>
        <p className="text-sm text-muted mt-1">Manage accounts, roles, and access.</p>
      </header>

      {error && <ErrorBox message={error} />}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
          <input
            type="text"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            placeholder="e.g. Alex Chen, student@example.com, or editor"
            className="w-full pl-9 pr-3 py-2 bg-surface border border-strong rounded-md text-sm focus:ring-2 focus:ring-ring/25 outline-none"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }}
          className="px-3 py-2 bg-surface border border-strong rounded-md text-sm focus:ring-2 focus:ring-ring/25 outline-none"
        >
          <option value="all">All roles</option>
          <option value="student">Students</option>
          <option value="teacher">Teachers</option>
          <option value="admin">Admins</option>
        </select>
      </div>

      {/* Only show the spinner before the first result set arrives. Swapping
          the table out on every refetch made the list flash and jump while the
          search box was still being typed into. */}
      {loading && !data ? <LoadingSpinner /> : data && (
        <>
          <div className="bg-surface rounded-lg border border-line overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-raised text-muted text-xs uppercase">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">User</th>
                    <th className="text-left px-4 py-3 font-medium">Role</th>
                    <th className="text-left px-4 py-3 font-medium">Activity</th>
                    <th className="text-left px-4 py-3 font-medium">Joined</th>
                    <th className="text-right px-4 py-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-subtle">
                  {data.users.map((u) => (
                    <tr key={u.id} className="hover:bg-surface-hover dark:hover:bg-gray-800/30">
                      <td className="px-4 py-3">
                        <button onClick={() => setDetailUser(u)} className="flex items-center gap-3 text-left">
                          <Avatar name={u.name} image={u.image} />
                          <div className="min-w-0">
                            <p className="font-medium truncate flex items-center gap-1.5">
                              {u.name ?? 'Unnamed'}
                              {u.effectiveAdmin && <Shield className="w-3.5 h-3.5 text-secondary" />}
                            </p>
                            <p className="text-xs text-muted truncate">{u.email}</p>
                          </div>
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={u.role}
                          disabled={u.effectiveAdmin || actionLoading === u.id}
                          onChange={(e) => updateRole(u.id, e.target.value)}
                          className="text-xs px-2 py-1 bg-surface-raised border border-line rounded-md focus:ring-1 focus:ring-ring/25 outline-none disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                          <option value="student">student</option>
                          <option value="teacher">teacher</option>
                          <option value="admin">admin</option>
                        </select>
                        {u.banned && <span className="ml-2 text-[10px] text-danger font-medium">BANNED</span>}
                        {!u.emailVerified && <span className="ml-2 text-[10px] text-warning font-medium">UNVERIFIED</span>}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">
                        {u._count.posts} posts · {u._count.notes} notes · {u._count.mockExams} exams
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">{new Date(u.createdAt).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => toggleVerified(u)}
                            disabled={actionLoading === u.id}
                            title={u.emailVerified ? 'Remove verification' : 'Mark verified'}
                            aria-label={u.emailVerified ? `Remove email verification for ${u.email}` : `Mark ${u.email} verified`}
                            className={`p-1.5 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                              u.emailVerified
                                ? 'text-muted hover:bg-surface-hover'
                                : 'text-warning hover:bg-warning-subtle'
                            }`}
                          >
                            {u.emailVerified ? <MailX className="w-4 h-4" /> : <MailCheck className="w-4 h-4" />}
                          </button>
                          <button
                            onClick={() => resetPassword(u)}
                            disabled={actionLoading === u.id}
                            title="Reset password"
                            aria-label={`Reset password for ${u.email}`}
                            className="p-1.5 rounded-md text-secondary hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            <KeyRound className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => toggleBan(u)}
                            disabled={u.effectiveAdmin || actionLoading === u.id}
                            title={u.banned ? 'Unban' : 'Ban'} aria-label={u.banned ? 'Unban' : 'Ban'}
                            className={`p-1.5 rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                              u.banned
                                ? 'text-accent-text hover:bg-accent-subtle'
                                : 'text-warning hover:bg-warning-subtle'
                            }`}
                          >
                            {actionLoading === u.id ? <Loader2 className="w-4 h-4 animate-spin" /> : u.banned ? <CheckCircle className="w-4 h-4" /> : <Ban className="w-4 h-4" />}
                          </button>
                          <button
                            onClick={() => deleteUser(u)}
                            disabled={u.effectiveAdmin || actionLoading === u.id}
                            title="Delete user"
                            aria-label={`Delete ${u.email}`}
                            className="p-1.5 rounded-md text-danger hover:bg-danger-subtle transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted">
              {data.users.length} of {data.total} users · Page {data.page} of {data.totalPages}
            </p>
            <div className="flex gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="p-2 rounded-md border border-line hover:bg-surface-hover disabled:opacity-30"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPage((p) => Math.min(data.totalPages, p + 1))}
                disabled={page >= data.totalPages}
                className="p-2 rounded-md border border-line hover:bg-surface-hover disabled:opacity-30"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </>
      )}

      {/* User detail modal */}
      {detailUser && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setDetailUser(null)}>
          <div className="bg-surface rounded-lg max-w-lg w-full p-6 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <Avatar name={detailUser.name} image={detailUser.image} size="lg" />
                <div>
                  <h3 className="font-bold">{detailUser.name ?? 'Unnamed'}</h3>
                  <p className="text-sm text-muted">{detailUser.email}</p>
                </div>
              </div>
              <button onClick={() => setDetailUser(null)} className="p-1 text-muted hover:text-secondary"><X className="w-5 h-5" /></button>
            </div>
            <div className="space-y-2 text-sm">
              <DetailRow label="Role" value={detailUser.role} />
              <DetailRow label="Effective Admin" value={detailUser.effectiveAdmin ? 'Yes (env allowlist or role)' : 'No'} />
              <DetailRow label="Banned" value={detailUser.banned ? `Yes — ${detailUser.bannedReason ?? 'no reason'}` : 'No'} />
              <DetailRow label="Email verified" value={detailUser.emailVerified ? new Date(detailUser.emailVerified).toLocaleString() : 'Not verified — sign-in is blocked'} />
              <DetailRow label="Joined" value={new Date(detailUser.createdAt).toLocaleString()} />
              <DetailRow label="Onboarded" value={detailUser.onboardedAt ? new Date(detailUser.onboardedAt).toLocaleString() : 'Not yet'} />
              <hr className="border-subtle my-2" />
              <DetailRow label="Notes" value={detailUser._count.notes} />
              <DetailRow label="Threads" value={detailUser._count.threads} />
              <DetailRow label="Posts" value={detailUser._count.posts} />
              <DetailRow label="Mock Exams" value={detailUser._count.mockExams} />
              <DetailRow label="Past-Paper Attempts" value={detailUser._count.pastPaperAttempts} />
              <DetailRow label="School Resources" value={detailUser._count.schoolResources} />
              <DetailRow label="AI Requests" value={detailUser._count.usageRecords} />
            </div>
          </div>
        </div>
      )}

      {/* One-time temporary-password reveal. The server stores only the hash,
          so once this closes the value is unrecoverable. */}
      {tempPassword && (
        <div
          className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="temp-password-title"
        >
          <div className="bg-surface rounded-lg max-w-md w-full p-6">
            <div className="flex items-start justify-between mb-3">
              <h3 id="temp-password-title" className="font-bold flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-secondary" />
                Temporary password set
              </h3>
              <button
                onClick={() => setTempPassword(null)}
                aria-label="Close"
                className="p-1 text-muted hover:text-secondary"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-secondary">
              Give this to <span className="font-medium">{tempPassword.email}</span>.
              It is shown once — after you close this dialog it cannot be retrieved,
              only reset again.
            </p>
            <div className="mt-4 flex items-center gap-2">
              <code className="flex-1 px-3 py-2.5 rounded-md bg-surface-raised font-mono text-base tracking-wider select-all break-all">
                {tempPassword.password}
              </code>
              <button
                onClick={() => {
                  void navigator.clipboard?.writeText(tempPassword.password);
                }}
                title="Copy to clipboard"
                aria-label="Copy temporary password to clipboard"
                className="p-2.5 rounded-md border border-line hover:bg-surface-hover"
              >
                <Copy className="w-4 h-4" />
              </button>
            </div>
            <p className="mt-3 text-xs text-warning">
              Ask them to sign in and change it from Account Settings. Devices already
              signed in as this user stay signed in until their session expires.
            </p>
            <button
              onClick={() => setTempPassword(null)}
              className="mt-5 w-full py-2.5 rounded-md bg-surface-inverse text-inverse font-medium"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Avatar({ name, image, size = 'sm' }: { name: string | null; image: string | null; size?: 'sm' | 'lg' }) {
  const dims = size === 'lg' ? 'w-12 h-12' : 'w-8 h-8';
  const text = size === 'lg' ? 'text-lg' : 'text-xs';
  if (image) return <img src={image} alt="" className={`${dims} rounded-full object-cover`} />;
  return (
    <div className={`${dims} rounded-full bg-accent flex items-center justify-center text-white ${text} font-bold flex-shrink-0`}>
      {name?.[0]?.toUpperCase() ?? '?'}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <span className="font-medium">{typeof value === 'number' ? value.toLocaleString() : value}</span>
    </div>
  );
}
