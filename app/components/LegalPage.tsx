import Link from 'next/link';
import { GraduationCap, AlertTriangle } from 'lucide-react';

/**
 * Shared chrome for /terms and /privacy.
 *
 * Both pages are reachable signed-out and are linked from the signup form, so
 * they are server components with no client JavaScript at all -- the same
 * reason the landing page is.
 */

/**
 * Whether to show the "not yet reviewed" banner.
 *
 * These pages were drafted from what the code actually does, which is the half
 * that can be checked against the repository. The half that cannot -- how long
 * data is kept, who to contact, whose law governs a dispute -- is marked
 * REVIEW in the copy and is the site owner's to decide.
 *
 * **Flip this to `false` once that copy is settled**, and search both pages for
 * "REVIEW" first: shipping a policy that promises something untrue is worse
 * than shipping no policy, and worse still when the readers are students at
 * one school who can all be identified.
 */
export const LEGAL_COPY_IS_DRAFT = true;

export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <header className="border-b border-gray-200 dark:border-gray-800">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-3">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-accent">
              <GraduationCap className="w-5 h-5 text-white" />
            </span>
            <span className="font-bold tracking-tight">YKPao Study</span>
          </Link>
          <Link
            href="/auth/login"
            className="text-sm font-medium text-green-600 hover:text-green-700 dark:text-green-500"
          >
            Sign in
          </Link>
        </div>
      </header>

      <article className="max-w-3xl mx-auto px-6 py-12 sm:py-16">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">{title}</h1>
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-500">Last updated {updated}</p>

        {LEGAL_COPY_IS_DRAFT && (
          <div className="mt-8 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-amber-900 dark:text-amber-200 leading-relaxed">
              <span className="font-semibold">Draft.</span> This text describes how the
              platform currently works, but it has not been reviewed and is not yet a
              binding agreement. Points still to be settled are marked{' '}
              <span className="font-mono text-xs px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40">
                REVIEW
              </span>
              .
            </p>
          </div>
        )}

        <div className="mt-10 space-y-10">{children}</div>

        <footer className="mt-16 pt-8 border-t border-gray-200 dark:border-gray-800 text-sm text-gray-500 dark:text-gray-500 flex gap-6">
          <Link href="/terms" className="hover:text-gray-900 dark:hover:text-gray-300">Terms</Link>
          <Link href="/privacy" className="hover:text-gray-900 dark:hover:text-gray-300">Privacy</Link>
          <Link href="/" className="hover:text-gray-900 dark:hover:text-gray-300">Home</Link>
        </footer>
      </article>
    </main>
  );
}

/** One numbered section. */
export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-semibold tracking-tight">{heading}</h2>
      <div className="mt-3 space-y-3 text-gray-700 dark:text-gray-300 leading-relaxed [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-2 [&_a]:text-green-600 [&_a]:underline">
        {children}
      </div>
    </section>
  );
}

/** Marks a decision the site owner still has to make. */
export function Review({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-200 font-medium">
      REVIEW: {children}
    </span>
  );
}
