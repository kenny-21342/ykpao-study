import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FileText } from 'lucide-react';
import { getSessionUser } from '@/lib/auth';
import { listBankPapers } from '@/lib/bank-questions';
import PreviewNotice from '@/app/components/PreviewNotice';
import { PageHeader } from '@/app/components/ui';

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
  if (!user) redirect('/auth/login');

  const papers = await listBankPapers();

  return (
    <main className="min-h-full bg-surface-raised">
      <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
        {/* The back link, title and supporting line were hand-rolled here and
            again on the paper page, which is what PageHeader is for. The
            supporting line stays: unlike an explain-the-page subtitle it says
            something a student cannot infer -- that these are crops of the real
            paper rather than retyped text. */}
        <PageHeader
          back={{ href: '/papers', label: 'Past papers' }}
          title="Question bank"
          description="Past-paper questions, one at a time, shown as they appear on the paper."
        />

        <PreviewNotice feature="question-bank" />

        {papers.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface p-6 text-sm text-muted">
            No papers have been published to the bank yet.
          </p>
        ) : (
          <ul className="divide-y divide-subtle overflow-hidden rounded-lg border border-line bg-surface">
            {papers.map((paper) => (
              <li key={paper.id}>
                <Link
                  href={`/bank/papers/${paper.id}`}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-surface-hover"
                >
                  <FileText className="h-4 w-4 flex-shrink-0 text-muted" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-primary">
                      {paper.subject.name} · Paper{' '}
                      {paper.variant ? `${paper.paperNumber}${paper.variant}` : paper.paperNumber}
                    </span>
                    <span className="block text-xs text-muted">
                      {paper.year} · {SESSIONS[paper.session] ?? paper.session}
                    </span>
                  </span>
                  <span className="flex-shrink-0 text-xs tabular-nums text-muted">
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
