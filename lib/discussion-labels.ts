// Predefined label taxonomy for the discussion board.
//
// A single free-text `category` column already exists on DiscussionThread.
// Rather than migrate the schema, we constrain that column to this fixed
// taxonomy so the UI can render a stable, predictable set of filter pills
// and badge colours. Legacy free-text categories are preserved on read
// (the client renders unknown categories with a neutral style) but new
// threads are restricted to the values below.

export type DiscussionLabel = {
  slug: string;
  name: string;
  // Tailwind classes for the badge + active filter pill.
  badge: string;
  pill: string;
};

export const DISCUSSION_LABELS: DiscussionLabel[] = [
  {
    slug: 'question',
    name: 'Question',
    badge: 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
    pill: 'bg-blue-600 text-white',
  },
  {
    slug: 'help-wanted',
    name: 'Help Wanted',
    badge: 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300',
    pill: 'bg-red-600 text-white',
  },
  {
    slug: 'tip',
    name: 'Tip',
    badge: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
    pill: 'bg-emerald-600 text-white',
  },
  {
    slug: 'resource',
    name: 'Resource',
    badge: 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
    pill: 'bg-purple-600 text-white',
  },
  {
    slug: 'debate',
    name: 'Debate',
    badge: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
    pill: 'bg-amber-600 text-white',
  },
  {
    slug: 'announcement',
    name: 'Announcement',
    badge: 'bg-pink-50 dark:bg-pink-900/30 text-pink-700 dark:text-pink-300',
    pill: 'bg-pink-600 text-white',
  },
  {
    slug: 'off-topic',
    name: 'Off-Topic',
    badge: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300',
    pill: 'bg-gray-600 text-white',
  },
];

export const DISCUSSION_LABEL_SLUGS = DISCUSSION_LABELS.map((l) => l.slug);

export function isValidLabelSlug(slug: string | null | undefined): boolean {
  return !!slug && DISCUSSION_LABEL_SLUGS.includes(slug);
}

export function getLabelMeta(slug: string | null | undefined): DiscussionLabel | null {
  if (!slug) return null;
  return DISCUSSION_LABELS.find((l) => l.slug === slug) ?? null;
}
