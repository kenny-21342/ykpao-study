'use client';

import { useState } from 'react';
import { BookOpen, Library } from 'lucide-react';
import NotesTextbookPage from './NotesTextbook';
import ResourceLibrary from './ResourceLibrary';
import { PageHeader, SegmentedControl } from './ui';

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
        {/*
          * Materials owns the page title for both halves of itself. Neither
          * child can: the notebook has no page header at all, and the library
          * used to render its own, which put two titles on the screen in one
          * view and none in the other.
          */}
        <div className="border-b border-line bg-surface px-4 py-4 sm:px-6">
          <PageHeader
            className="mb-0"
            title="Materials"
            actions={
              <SegmentedControl
                ariaLabel="Materials view"
                value={view}
                onChange={setView}
                items={[
                  { value: 'workspace', label: 'Notebook', icon: BookOpen },
                  { value: 'library', label: 'Library', icon: Library },
                ]}
              />
            }
          />
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
