/**
 * Loading placeholders.
 *
 * The app had exactly one real skeleton (`AppSidebar`), and everywhere else a
 * pending fetch rendered either nothing, a bare panel, or -- worst -- the
 * empty state, which tells an active student they have no history while their
 * history is still on its way. These are the shapes needed to fix that
 * without inventing a new grey box each time.
 *
 * No `'use client'`: they render no state and no handlers, so they work in a
 * server component too.
 *
 * `animate-pulse` is a Tailwind opacity animation, which `prefers-reduced-
 * motion` users should not be given. Tailwind has no built-in variant for
 * that, so the animation is applied through `motion-safe:`, which compiles to
 * exactly that media query.
 */

const BASE = 'motion-safe:animate-pulse rounded bg-gray-200 dark:bg-gray-700';

/** One grey bar. Give it a width and a height in the caller's own grid. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden="true" className={`${BASE} ${className}`} />;
}

/**
 * A paragraph of bars. The last one is short, because a real last line is --
 * a block of equal-length bars reads as a table, not as prose.
 */
export function SkeletonText({
  lines = 3,
  className = '',
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className={`${BASE} h-3`}
          style={{ width: i === lines - 1 ? '60%' : '100%' }}
        />
      ))}
    </div>
  );
}

/** A bordered card with a title bar and a few lines, for list placeholders. */
export function SkeletonCard({ lines = 2, className = '' }: { lines?: number; className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`rounded-xl border border-gray-200 p-4 dark:border-gray-700 ${className}`}
    >
      <div className={`${BASE} h-4 w-1/3`} />
      <SkeletonText lines={lines} className="mt-3" />
    </div>
  );
}

/**
 * Wraps a loading region so assistive technology is told something is coming.
 *
 * The bars themselves are `aria-hidden`; this is what actually announces.
 * Without it a screen-reader user gets silence, which is indistinguishable
 * from an empty page.
 */
export function SkeletonRegion({
  label = 'Loading',
  className = '',
  children,
}: {
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}
