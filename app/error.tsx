'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle, RotateCw } from 'lucide-react';

/**
 * Route-level error boundary for the whole app.
 *
 * This catches *any* render or data error in any route — it is not
 * auth-specific, so it must not tell the student their session is broken or
 * bounce them to the login page.
 *
 * Most crashes here are transient (a failed fetch during render, a bad
 * payload), so the primary action is `unstable_retry()`, which re-fetches and
 * re-renders the boundary's children. Next 16 prefers it over `reset()`, which
 * only clears the error state without re-fetching.
 */
export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    // Once error reporting is wired up, forward `error` (and `error.digest`,
    // which correlates with the server-side log entry) here.
    console.error('Application error:', error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-8 text-center">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-warning-subtle">
          <AlertTriangle className="h-6 w-6 text-warning" />
        </div>

        <h1 className="mb-2 text-xl font-bold text-primary">
          Something went wrong
        </h1>
        <p className="mb-6 text-sm leading-6 text-secondary">
          This page didn&apos;t load properly. Your work is saved — trying again
          usually fixes it.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            onClick={() => unstable_retry()}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-accent px-5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover"
          >
            <RotateCw className="h-4 w-4" />
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-strong px-5 text-sm font-semibold text-secondary transition-colors hover:bg-surface-hover"
          >
            Back to dashboard
          </Link>
        </div>

        {error.digest && (
          <p className="mt-6 text-[11px] text-muted">
            Reference: {error.digest}
          </p>
        )}
      </div>
    </div>
  );
}
