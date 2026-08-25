import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, FileText } from 'lucide-react';
import { getSessionUser } from '@/lib/auth';
import { listBankPapers } from '@/lib/bank-questions';
import PreviewNotice from '@/app/components/PreviewNotice';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Question bank',
};

const SESSIONS: Record<string, string> = {
  s: 'May/June',
  w: 'Oct/Nov',
  m: 'Feb/March',
};

/**
 * Papers that have published questions.
 *
 * Deliberately a flat list rather than a subject browser: coverage is partial
 * while the corpus is still being cropped, so a subject tree would be mostly
 * empty branches. It can grow into one once the archive is filled in.
 */
export default async function BankIndexPage() {
  const user = await getSessionUser();
  if (!user) redirect('/auth/signin');

  const papers = await listBankPapers();

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
        <div>
          <Link
            href="/papers"
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-green-600 dark:text-gray-400"
          >
            <ArrowLeft className="h-4 w-4" />
            Past papers
          </Link>
          <h1 className="mt-1 text-xl font-bold text-gray-900 dark:text-white">Question bank</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Past-paper questions, one at a time, shown as they appear on the paper.
          </p>
        </div>

        <PreviewNotice feature="question-bank" />

        {papers.length === 0 ? (
          <p className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
            No papers have been published to the bank yet.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800">
            {papers.map((paper) => (
              <li key={paper.id}>
                <Link
                  href={`/bank/papers/${paper.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  <FileText className="h-4 w-4 flex-shrink-0 text-gray-400" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-gray-900 dark:text-white">
                      {paper.subject.name} · Paper{' '}
                      {paper.variant ? `${paper.paperNumber}${paper.variant}` : paper.paperNumber}
                    </span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">
                      {paper.year} · {SESSIONS[paper.session] ?? paper.session}
                    </span>
                  </span>
                  <span className="flex-shrink-0 text-xs tabular-nums text-gray-500 dark:text-gray-400">
                    {paper._count.questions}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
