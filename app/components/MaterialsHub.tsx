'use client';

import { useState } from 'react';
import { BookOpen, Library } from 'lucide-react';
import NotesTextbookPage from './NotesTextbook';
import ResourceLibrary from './ResourceLibrary';

type MaterialsView = 'workspace' | 'library';

export default function MaterialsHub() {
  const [view, setView] = useState<MaterialsView>('workspace');

  return (
    <div className="h-full overflow-hidden bg-gray-50 dark:bg-gray-950">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 py-3 dark:border-gray-800 dark:bg-gray-900 sm:px-6">
          <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Materials</h2>
          <div className="inline-flex rounded-md border border-gray-200 bg-gray-100 p-1 dark:border-gray-700 dark:bg-gray-800">
            <button
              onClick={() => setView('workspace')}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
                view === 'workspace'
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-gray-100'
                  : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
              }`}
            >
              <BookOpen className="h-4 w-4" />
              Notebook
            </button>
            <button
              onClick={() => setView('library')}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ${
                view === 'library'
                  ? 'bg-white text-gray-900 shadow-sm dark:bg-gray-900 dark:text-gray-100'
                  : 'text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
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
