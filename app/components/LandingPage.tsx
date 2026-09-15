import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { FEATURE_READINESS } from '@/lib/feature-readiness';
import {
  GraduationCap,
  Target,
  BookOpen,
  FileText,
  Brain,
  ClipboardList,
  NotebookPen,
  Repeat,
  Search,
  ArrowRight,
  Info,
} from 'lucide-react';

/**
 * What a stranger sees at `/`.
 *
 * This is a **server** component, and that is the point of it. The signed-out
 * view used to be a branch inside the `'use client'` app shell, so a link
 * shared into a group chat or handed to a search crawler resolved to an empty
 * div and a bundle -- there was no text in the response at all. Everything
 * below is rendered on the server, so the page has real content before any
 * JavaScript runs.
 *
 * The numbers come straight from the database rather than through
 * `/api/platform-stats`, for the same reason: a client fetch would put them
 * back outside the crawled document, and a server component can simply query.
 */

/** Counted here so the figures are in the HTML, not fetched after paint. */
async function loadStats() {
  try {
    const [questions, subjects, papers] = await Promise.all([
      prisma.bankQuestion.count({ where: { status: 'published' } }),
      // Distinct syllabus **codes**, not `bank_subjects` rows.
      //
      // A row is (board, code, level), so 0620 IGCSE and 0620 at another level
      // are two rows and one syllabus as far as a student is concerned.
      // Counting rows gave 82 against the 49 the readiness banner names, and
      // the two now sit on the same page -- a visitor reading both would see
      // the platform contradict itself about its own size.
      prisma.bankSubject
        .findMany({
          where: { papers: { some: { questions: { some: { status: 'published' } } } } },
          select: { code: true },
          distinct: ['code'],
        })
        .then((rows) => rows.length),
      prisma.bankPaper.count({ where: { docType: 'qp' } }),
    ]);
    return { questions, subjects, papers };
  } catch {
    // A landing page that 500s because a count timed out is worse than one
    // with no numbers on it. The prose below stands on its own.
    return null;
  }
}

const compact = (n: number) => n.toLocaleString('en-GB');

const FEATURES = [
  {
    icon: Target,
    title: 'Practise real exam questions',
    body:
      'Every question is a crop of the paper it came from, with its own mark scheme. Filter by subject, paper, year or topic and work through them one at a time.',
  },
  {
    icon: Brain,
    title: 'Get your written answers marked',
    body:
      'Bring your own AI key and written answers come back with a score against the mark scheme, what you did well, and what the examiner was looking for that you missed.',
  },
  {
    icon: Repeat,
    title: 'Revisit what you got wrong',
    body:
      'Mistakes become review cards on a spaced-repetition schedule, so the questions you fumbled come back at the interval you are most likely to have forgotten them.',
  },
  {
    icon: ClipboardList,
    title: 'Sit a mock paper',
    body:
      'Generate a timed paper to a mark total you choose, sit it against the clock, and get it marked question by question.',
  },
  {
    icon: NotebookPen,
    title: 'Keep notes that do more than sit there',
    body:
      'A notebook with LaTeX, live formula checking and reopenable drawings, shared with classmates when you want a second pair of eyes.',
  },
  {
    icon: Search,
    title: 'Search everything at once',
    body:
      'One search across questions, mark schemes, your own notes, uploaded resources and the discussion board.',
  },
];

export default async function LandingPage() {
  const stats = await loadStats();

  return (
    <main className="min-h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      {/* Top bar */}
      <header className="border-b border-gray-200 dark:border-gray-800">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-accent">
              <GraduationCap className="w-6 h-6 text-white" />
            </span>
            <span className="font-bold text-lg tracking-tight">YKPao Study</span>
          </div>
          <nav className="flex items-center gap-2 sm:gap-3">
            <Link
              href="/auth/login"
              className="px-4 py-2 text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-900 transition"
            >
              Sign in
            </Link>
            <Link
              href="/auth/signup"
              className="px-4 py-2 text-sm font-semibold rounded-md text-white bg-accent hover:from-green-600 hover:to-emerald-700 transition"
            >
              Create an account
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-16 pb-12 sm:pt-24 sm:pb-16">
        <h1 className="text-4xl sm:text-6xl font-bold tracking-tight text-balance max-w-3xl">
          The past papers,{' '}
          <span className="text-accent-text">
            already cut into questions
          </span>
          .
        </h1>
        <p className="mt-6 text-lg sm:text-xl text-gray-600 dark:text-gray-400 max-w-2xl leading-relaxed">
          A revision platform built around the IGCSE and A-level archive: every question
          separated from its paper, paired with its mark scheme, and ready to practise,
          mark and come back to.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/auth/signup"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg font-semibold text-white bg-accent hover:from-green-600 hover:to-emerald-700 transition"
          >
            Start studying
            <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="/auth/login"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-lg font-semibold border border-gray-300 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-900 transition"
          >
            I already have an account
          </Link>
        </div>

        {/* Corpus figures. Omitted entirely rather than shown as zeros if the
            count failed -- a landing page with no numbers reads as restrained,
            one with "0" reads as broken. */}
        {stats && (
          <dl className="mt-14 grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { label: 'Exam questions', value: compact(stats.questions), icon: Target },
              { label: 'Syllabuses covered', value: compact(stats.subjects), icon: BookOpen },
              { label: 'Question papers', value: compact(stats.papers), icon: FileText },
            ].map(({ label, value, icon: Icon }) => (
              <div
                key={label}
                className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 px-6 py-5"
              >
                <Icon className="w-5 h-5 text-green-600 dark:text-green-500" />
                <dd className="mt-3 text-3xl font-bold tabular-nums">{value}</dd>
                <dt className="mt-1 text-sm text-gray-600 dark:text-gray-400">{label}</dt>
              </div>
            ))}
          </dl>
        )}
      </section>

      {/* What it does */}
      <section className="border-t border-gray-200 dark:border-gray-800 bg-gray-50/60 dark:bg-gray-900/30">
        <div className="max-w-6xl mx-auto px-6 py-16 sm:py-20">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
            Six things it does
          </h2>
          <div className="mt-10 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div
                key={title}
                className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6"
              >
                <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-green-50 dark:bg-green-900/30">
                  <Icon className="w-5 h-5 text-green-600 dark:text-green-500" />
                </span>
                <h3 className="mt-4 font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                  {body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* What is not finished. Said here rather than discovered later: the same
          copy the in-app preview banners carry, from one table. */}
      <section className="max-w-6xl mx-auto px-6 py-16 sm:py-20">
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 mt-1 text-amber-500 flex-shrink-0" />
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
              What is still unfinished
            </h2>
            <p className="mt-3 text-gray-600 dark:text-gray-400 max-w-2xl leading-relaxed">
              This is a student project, still being built. Two parts are usable but
              incomplete, and you should know which before you rely on them.
            </p>
          </div>
        </div>
        <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-6">
          {Object.values(FEATURE_READINESS).map((feature) => (
            <div
              key={feature.title}
              className="rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50/60 dark:bg-amber-900/10 p-6"
            >
              <h3 className="font-semibold text-amber-900 dark:text-amber-200">
                {feature.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-amber-900/80 dark:text-amber-200/70">
                {feature.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Closing call to action */}
      <section className="border-t border-gray-200 dark:border-gray-800">
        <div className="max-w-6xl mx-auto px-6 py-16 sm:py-20 text-center">
          <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
            Start with one question
          </h2>
          <p className="mt-3 text-gray-600 dark:text-gray-400 max-w-xl mx-auto leading-relaxed">
            Making an account takes a minute and needs nothing but a working school
            email address.
          </p>
          <Link
            href="/auth/signup"
            className="mt-8 inline-flex items-center gap-2 px-6 py-3 rounded-lg font-semibold text-white bg-accent hover:from-green-600 hover:to-emerald-700 transition"
          >
            Create an account
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </section>

      <footer className="border-t border-gray-200 dark:border-gray-800">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-gray-500 dark:text-gray-500">
          <span>YKPao Study</span>
          <nav className="flex items-center gap-6">
            <Link href="/terms" className="hover:text-gray-900 dark:hover:text-gray-300 transition">
              Terms
            </Link>
            <Link href="/privacy" className="hover:text-gray-900 dark:hover:text-gray-300 transition">
              Privacy
            </Link>
            <Link href="/auth/login" className="hover:text-gray-900 dark:hover:text-gray-300 transition">
              Sign in
            </Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}
