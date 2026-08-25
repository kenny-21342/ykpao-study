import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getSessionUser } from '@/lib/auth';
import { getBankPaper } from '@/lib/bank-questions';
import BankQuestionCard from '@/app/components/BankQuestionView';
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
 * One paper's questions, each shown as the crop cut from the original.
 *
 * Behind the question-bank preview banner: coverage is partial, so a student
 * landing here should know this is not the finished archive.
 */
export default async function BankPaperPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // The crops are cut from copyrighted papers and are cohort-private, exactly
  // like the images they are served alongside.
  const user = await getSessionUser();
  if (!user) redirect('/auth/signin');

  const { id } = await params;
  const paperId = Number.parseInt(id, 10);
  if (!Number.isInteger(paperId) || paperId <= 0) notFound();

  const paper = await getBankPaper(paperId);
  if (!paper) notFound();

  const session = SESSIONS[paper.session] ?? paper.session;
  const variant = paper.variant ? `${paper.paperNumber}${paper.variant}` : `${paper.paperNumber}`;

  return (
    <main className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
        <div>
          <Link
            href="/papers"
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-green-600 dark:text-gray-400"
          >
            <ArrowLeft className="h-4 w-4" />
            Past papers
          </Link>
          <h1 className="mt-1 text-xl font-bold text-gray-900 dark:text-white">
            {paper.subject} · Paper {variant}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {paper.board} · {paper.year} · {session} ·{' '}
            {paper.questions.length === 1
              ? '1 question'
              : `${paper.questions.length} questions`}
          </p>
        </div>

        <PreviewNotice feature="question-bank" />

        {paper.questions.length === 0 ? (
          <p className="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
            No questions from this paper have been published yet.
          </p>
        ) : (
          <div className="space-y-4">
            {paper.questions.map((question) => (
              <BankQuestionCard key={question.id} question={question} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
