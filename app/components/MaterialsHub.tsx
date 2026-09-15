'use client';

import { useState } from 'react';
import { BookOpen, Library } from 'lucide-react';
import NotesTextbookPage from './NotesTextbook';
import ResourceLibrary from './ResourceLibrary';

type MaterialsView = 'workspace' | 'library';

export default function MaterialsHub() {
  const [view, setView] = useState<MaterialsView>('workspace');

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
          {view === 'workspace' ? <NotesTextbookPage /> : <ResourceLibrary />}
        </div>
      </div>
    </div>
  );
}
