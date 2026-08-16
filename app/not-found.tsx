import Link from 'next/link';
import { Compass } from 'lucide-react';

/**
 * 404 page. Without this file Next.js renders its unstyled default, which
 * drops the student out of the app's look and gives them no way back.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-xl dark:border-gray-800 dark:bg-gray-900">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950/40">
          <Compass className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
        </div>

        <h1 className="mb-2 text-xl font-bold text-gray-900 dark:text-gray-100">
          Page not found
        </h1>
        <p className="mb-6 text-sm leading-6 text-gray-600 dark:text-gray-400">
          This link may be out of date, or the page may have moved.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Link
            href="/"
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-emerald-600 px-5 text-sm font-semibold text-white transition-colors hover:bg-emerald-700"
          >
            Back to dashboard
          </Link>
          <Link
            href="/papers"
            className="inline-flex min-h-11 items-center justify-center rounded-xl border border-gray-300 px-5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Browse past papers
          </Link>
        </div>
      </div>
    </div>
  );
}
