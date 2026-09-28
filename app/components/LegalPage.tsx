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
 * data is kept, who to contact, whose law governs a dispute, whether the school
 * stands behind any of it -- was drafted too, conservatively, but is the site
 * owner's to confirm or correct.
 *
 * **Confirmed by the owner on 28 Sep 2026**, so the draft banner is off and
 * both pages are now a binding agreement. Four claims are the promises the
 * platform has to keep, and each has to be re-checked whenever the thing
 * underneath it changes:
 *
 *  1. the 30-day account-deletion window in /privacy
 *  2. the 90-day backup window in /privacy. `db-backup.yml` gained a retention
 *     step on 27 Sep that makes this true in principle, but the step has been
 *     FAILING since -- a bucket-level ListObjectsV2 returns NoSuchKey because
 *     BACKUP_S3_ENDPOINT already carries the bucket name, so the dumps are
 *     uploaded and never pruned. Until that is fixed this is the one sentence
 *     on either page the platform is not actually keeping.
 *  3. the 30-day shutdown notice in /terms
 *  4. the statement that this is a student project the school does not operate
 *     or endorse
 *
 * Shipping a policy that promises something untrue is worse than shipping no
 * policy, and worse still when the readers are students at one school who can
 * all be identified. That is why (2) is written down here rather than left in
 * a run log.
 */
export const LEGAL_COPY_IS_DRAFT = false;

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
    <main className="min-h-screen bg-surface text-primary">
      <header className="border-b border-line">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-3">
            <span className="inline-flex items-center justify-center w-9 h-9 rounded-md bg-accent">
              <GraduationCap className="w-5 h-5 text-white" />
            </span>
            <span className="font-bold tracking-tight">YKPao Study</span>
          </Link>
          <Link
            href="/auth/login"
            className="text-sm font-medium text-accent-text hover:text-accent-text"
          >
            Sign in
          </Link>
        </div>
      </header>

      <article className="max-w-3xl mx-auto px-6 py-12 sm:py-16">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">{title}</h1>
        <p className="mt-3 text-sm text-muted">Last updated {updated}</p>

        {LEGAL_COPY_IS_DRAFT && (
          <div className="mt-8 rounded-lg border border-warning-border bg-warning-subtle p-4 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
            <p className="text-sm text-warning leading-relaxed">
              <span className="font-semibold">Draft.</span> This text describes how the
              platform currently works, and every commitment in it is one the operator
              intends to keep, but it has not yet been confirmed by him and is not yet a
              binding agreement.
            </p>
          </div>
        )}

        <div className="mt-10 space-y-10">{children}</div>

        <footer className="mt-16 pt-8 border-t border-line text-sm text-muted flex gap-6">
          <Link href="/terms" className="hover:text-primary">Terms</Link>
          <Link href="/privacy" className="hover:text-primary">Privacy</Link>
          <Link href="/" className="hover:text-primary">Home</Link>
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
      <div className="mt-3 space-y-3 text-secondary leading-relaxed [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-2 [&_a]:text-accent-text [&_a]:underline">
        {children}
      </div>
    </section>
  );
}

/** Marks a decision the site owner still has to make. */
export function Review({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-1.5 py-0.5 rounded-sm bg-warning-subtle text-warning font-medium">
      REVIEW: {children}
    </span>
  );
}
