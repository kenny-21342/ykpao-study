'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Users, UserPlus, Trash2, Loader2, Crown, Pencil, Eye, Mail,
} from 'lucide-react';

type User = { id: string; name: string | null; email: string; image: string | null };

type Collaborator = {
  id: string;
  role: string;
  createdAt: string;
  user: User;
};

type CollabData = {
  owner: User | null;
  role: string; // current user's role ('owner' | 'editor' | 'viewer')
  collaborators: Collaborator[];
};

type Props = { noteId: string };

export default function CollaboratorPanel({ noteId }: Props) {
  const [data, setData] = useState<CollabData | null>(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'editor' | 'viewer'>('editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/notes/${noteId}/collaborators`);
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [noteId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const invite = async () => {
    if (!email.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/notes/${noteId}/collaborators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), role }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'Failed to invite');
      } else {
        setEmail('');
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (userId: string) => {
    // Optimistic.
    setData((d) => (d ? { ...d, collaborators: d.collaborators.filter((c) => c.user.id !== userId) } : d));
    await fetch(`/api/notes/${noteId}/collaborators?userId=${userId}`, { method: 'DELETE' });
    await load();
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading collaborators…
      </div>
    );
  }

  const isOwner = data?.role === 'owner';

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Users className="w-4 h-4 text-green-500" />
        <h4 className="text-sm font-bold text-gray-900 dark:text-gray-100">Collaborators</h4>
        <span className="text-xs text-gray-400">
          ({data?.collaborators.length ?? 0})
        </span>
      </div>

      {/* Invite form (owner only) */}
      {isOwner ? (
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="email"
              placeholder="student@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-800 dark:text-gray-200"
            />
          </div>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}
            className="px-2 py-2 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-800 dark:text-gray-200"
          >
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
          <button
            onClick={invite}
            disabled={!email.trim() || busy}
            className="inline-flex items-center gap-1 px-3 py-2 text-sm font-semibold bg-gradient-to-r from-green-500 to-emerald-500 text-white rounded-lg disabled:opacity-50 transition-all"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
            Invite
          </button>
        </div>
      ) : (
        <p className="text-xs text-gray-400">Only the owner can invite collaborators.</p>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      {/* People list */}
      <ul className="space-y-1">
        {/* Owner */}
        {data?.owner && (
          <li className="flex items-center gap-3 p-2 rounded-lg bg-gray-50 dark:bg-gray-800/50">
            <Avatar user={data.owner} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {data.owner.name ?? data.owner.email}
              </p>
              <p className="text-xs text-gray-400 truncate">{data.owner.email}</p>
            </div>
            <span className="inline-flex items-center gap-1 text-xs font-medium text-yellow-600 dark:text-yellow-400">
              <Crown className="w-3 h-3" /> Owner
            </span>
          </li>
        )}

        {/* Collaborators */}
        {data?.collaborators.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/50 group"
          >
            <Avatar user={c.user} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                {c.user.name ?? c.user.email}
              </p>
              <p className="text-xs text-gray-400 truncate">{c.user.email}</p>
            </div>
            <span
              className={`inline-flex items-center gap-1 text-xs font-medium ${
                c.role === 'editor'
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-gray-500'
              }`}
            >
              {c.role === 'editor' ? <Pencil className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              {c.role}
            </span>
            {(isOwner || c.user.id === data?.owner?.id) && isOwner && (
              <button
                onClick={() => remove(c.user.id)}
                className="text-gray-300 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                title="Remove" aria-label="Remove"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Avatar({ user }: { user: User }) {
  const initials = (user.name ?? user.email ?? '?')
    .split(/[\s@]/)
    .map((s) => s[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return user.image ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={user.image} alt="" className="w-8 h-8 rounded-full object-cover" />
  ) : (
    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-purple-400 text-white text-xs font-semibold flex items-center justify-center">
      {initials}
    </div>
  );
}
