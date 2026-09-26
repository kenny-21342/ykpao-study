'use client';

import { useEffect, useState } from 'react';
import { ChevronRight, Folder, FolderPlus, Home, Loader2 } from 'lucide-react';

type Crumb = { id: string; name: string };
type Folder = { id: string; name: string; parentId: string | null };

export default function ResourceFolderPicker({
  value, onChange, initialBreadcrumb = [], disabled = false,
}: {
  value: string | null;
  onChange: (id: string | null, breadcrumb: Crumb[]) => void;
  initialBreadcrumb?: Crumb[];
  disabled?: boolean;
}) {
  const [breadcrumb, setBreadcrumb] = useState<Crumb[]>(initialBreadcrumb);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch(`/api/school-resource-folders?parentId=${encodeURIComponent(value ?? '')}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Could not load folders');
        if (active) setFolders(body.folders ?? []);
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Could not load folders'); });
    return () => { active = false; };
  }, [value]);

  const navigate = (id: string | null, crumbs: Crumb[]) => {
    setBreadcrumb(crumbs);
    setError('');
    onChange(id, crumbs);
  };

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/school-resource-folders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, parentId: value }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Could not create folder');
      setName('');
      navigate(body.folder.id, [...breadcrumb, { id: body.folder.id, name: body.folder.name }]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create folder');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-line bg-surface-raised p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <button type="button" disabled={disabled} onClick={() => navigate(null, [])} className="inline-flex items-center gap-1 rounded-md px-2 py-1 hover:bg-surface disabled:opacity-50"><Home className="h-3.5 w-3.5" /> Root</button>
        {breadcrumb.map((crumb, index) => (
          <span key={crumb.id} className="inline-flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-muted" />
            <button type="button" disabled={disabled} onClick={() => navigate(crumb.id, breadcrumb.slice(0, index + 1))} className="rounded-md px-1 py-1 hover:bg-surface disabled:opacity-50">{crumb.name}</button>
          </span>
        ))}
      </div>
      <p className="text-xs text-muted">Upload destination: {breadcrumb.length ? breadcrumb.map((c) => c.name).join(' / ') : 'Root'}</p>
      {folders.length > 0 && (
        <div className="max-h-36 overflow-y-auto grid gap-1 sm:grid-cols-2">
          {folders.map((folder) => (
            <button key={folder.id} type="button" disabled={disabled} onClick={() => navigate(folder.id, [...breadcrumb, folder])} className="flex min-w-0 items-center gap-2 rounded-md bg-surface px-2 py-2 text-left text-sm hover:bg-surface-hover disabled:opacity-50">
              <Folder className="h-4 w-4 flex-shrink-0 text-warning" /><span className="truncate">{folder.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input value={name} onChange={(event) => setName(event.target.value)} disabled={disabled || busy} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void create(); } }} placeholder="New folder name" aria-label="New folder name" className="min-w-0 flex-1 rounded-md border border-strong bg-surface px-2 py-1.5 text-sm" />
        <button type="button" disabled={disabled || busy || !name.trim()} onClick={() => void create()} className="inline-flex items-center gap-1 rounded-md border border-strong px-2 py-1.5 text-sm disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />} Create
        </button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
