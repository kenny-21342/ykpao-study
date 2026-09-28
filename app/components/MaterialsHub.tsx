'use client';

import ResourceLibrary from './ResourceLibrary';
import { PageHeader } from './ui';

/**
 * Materials. One half now, not two.
 *
 * This used to be a Notebook / Library toggle over a full Notebook -> Section
 * -> Page workspace. The notebook was removed on 28 Sep 2026 -- the whole
 * feature is on the `notebooks-v1` tag and the `archive/notebooks` branch, with
 * a row-level export of its tables in backups/notebooks-2026-09-28/. It is kept
 * as a component with a header rather than collapsed into ResourceLibrary
 * because the library still must not render its own title, and because
 * Materials is a route the shell knows about.
 *
 * The supporting line belongs here, on the header, rather than at the top of
 * the library: as a paragraph of its own it sat below the header's rule and
 * inside the library's own page padding, so the title and the sentence
 * describing it were separated by about sixty pixels of nothing.
 */
export default function MaterialsHub() {
  return (
    <div className="h-full overflow-hidden bg-surface-raised">
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-line bg-surface px-4 py-4 sm:px-6">
          <PageHeader
            className="mb-0"
            title="Materials"
            description="Study notes shared on review.ykpao.com, and your school's own resources."
          />
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          <ResourceLibrary />
        </div>
      </div>
    </div>
  );
}
