'use client';

import { useState } from 'react';
import ResourceLibrary, { MaterialsTabs, type MaterialsTab } from './ResourceLibrary';
import { PageHeader } from './ui';

/**
 * Materials. One half now, not two.
 *
 * This used to be a Notebook / Library toggle over a full Notebook -> Section
 * -> Page workspace. The notebook was removed on 28 Sep 2026 -- the whole
 * feature is on the `notebooks-v1` tag and the `archive/notebooks` branch, with
 * a row-level export of its tables in backups/notebooks-2026-09-28/. It is kept
 * as a component with a header rather than collapsed into ResourceLibrary
 * because the library still must not render its own chrome, and because
 * Materials is a route the shell knows about.
 *
 * The title, the supporting line and the tab strip are all here, in one
 * bordered block, the way Study's header is built. Each was previously a
 * separate band: the header drew a rule, then the library's own page padding,
 * then a tab strip drawing a second rule. Two rules thirty pixels apart, with
 * the sentence describing the screen stranded between them.
 */
export default function MaterialsHub() {
  const [tab, setTab] = useState<MaterialsTab>('notes');

  return (
    <div className="h-full overflow-hidden bg-surface-raised">
      <div className="flex h-full min-h-0 flex-col">
        {/* px matches the library's own, so the title, the tabs and the content
            below all start on the same left edge. */}
        <div className="border-b border-line bg-surface px-6 md:px-8">
          <div className="mx-auto max-w-6xl">
            <PageHeader
              className="mb-0 pt-6 pb-4"
              title="Materials"
              description="Study notes shared on review.ykpao.com, and your school's own resources."
            />
            <MaterialsTabs tab={tab} onChange={setTab} />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <ResourceLibrary tab={tab} />
        </div>
      </div>
    </div>
  );
}
