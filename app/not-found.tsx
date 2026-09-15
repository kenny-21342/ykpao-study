import Link from 'next/link';
import { Compass } from 'lucide-react';

/**
 * 404 page. Without this file Next.js renders its unstyled default, which
 * drops the student out of the app's look and gives them no way back.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-8 text-center">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950/40">
          <Compass className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
        </div>

        <h1 className="mb-2 text-xl font-bold text-primary">
          Page not found
        </h1>
        <p className="mb-6 text-sm leading-6 text-secondary">
          This link may be out of date, or the page may have moved.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center justify-center rounded-lg bg-emerald-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
          >
            Back to dashboard
          </Link>
          <Link
            href="/papers"
            className="inline-flex min-h-11 items-center justify-center rounded-lg border border-strong px-5 text-sm font-semibold text-secondary transition-colors hover:bg-surface-hover"
          >
            Browse past papers
          </Link>
        </div>
      </div>
    </div>
  );
}
