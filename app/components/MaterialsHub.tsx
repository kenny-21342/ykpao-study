'use client';

import { useState } from 'react';
import { BookOpen, Library } from 'lucide-react';
import NotesTextbookPage from './NotesTextbook';
import ResourceLibrary from './ResourceLibrary';

type MaterialsView = 'workspace' | 'library';

export default function MaterialsHub({
  initialPageId = null,
  onPageOpened,
}: {
  /** A page named by the URL, opened once on arrival. */
  initialPageId?: string | null;
  /** Fires whenever the open page changes, so the shell can rewrite the URL. */
  onPageOpened?: (pageId: string | null) => void;
} = {}) {
  const [view, setView] = useState<MaterialsView>('workspace');

  // A link to a page has to land on the page, not on whichever half of
  // Materials the student last had open. Adjusted during render rather than in
  // an effect: an effect would paint Library first and then snap across, and
  // `honoured` means a student who arrives on a link can still click over to
  // Library afterwards -- deriving the view outright would pin them to the
  // workspace for as long as the id stayed in the URL.
  const [honoured, setHonoured] = useState<string | null>(null);
  if (initialPageId && initialPageId !== honoured) {
    setHonoured(initialPageId);
    setView('workspace');
  }

  return (
    <div className="h-full overflow-hidden bg-surface-raised">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 sm:px-6">
          <h2 className="text-lg font-bold text-primary">Materials</h2>
          <div className="inline-flex rounded-md border border-line bg-surface-raised p-1">
            <button
              onClick={() => setView('workspace')}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
                view === 'workspace'
                  ? 'bg-surface text-primary'
                  : 'text-muted hover:text-primary'
              }`}
            >
              <BookOpen className="h-4 w-4" />
              Notebook
            </button>
            <button
              onClick={() => setView('library')}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
                view === 'library'
                  ? 'bg-surface text-primary'
                  : 'text-muted hover:text-primary'
              }`}
            >
              <Library className="h-4 w-4" />
              Library
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {view === 'workspace'
            ? <NotesTextbookPage initialPageId={initialPageId} onPageOpened={onPageOpened} />
            : <ResourceLibrary />}
        </div>
      </div>
    </div>
  );
}
