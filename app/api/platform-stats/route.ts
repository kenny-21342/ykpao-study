import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';

/**
 * Dynamic, with the work memoised in the instance.
 *
 * This endpoint is unauthenticated, runs five queries -- one a nested
 * `some`/`some` across papers and questions -- and did all of it on every
 * request. Against a plan with 17 usable connection slots that is an
 * availability hole rather than a slow route. Measured on 26 Sep 2026: 25
 * concurrent requests returned 500 on all 25, made the database refuse new
 * connections for every other route, took `/api/health` to 503 with them, and
 * a local script could not connect at all while it ran.
 *
 * Nothing in the app calls it. `LandingPage` queries the database directly so
 * its figures land in the crawled HTML, so the only traffic here comes from
 * outside -- which is exactly the traffic that should not be able to do that.
 *
 * `export const revalidate` does not cache a Route Handler in Next 16 without
 * Cache Components (verified: the route still built as dynamic, and the only
 * effect was the build evaluating it and logging a Prisma error). The
 * documented alternative is `'use cache'` + `cacheLife` in an extracted
 * helper, which needs Cache Components enabled project-wide -- too large a
 * change to make for an endpoint nothing calls. So the memo below is
 * per-instance and deliberately plain.
 *
 * The in-flight promise matters more than the TTL. A TTL alone does nothing
 * for a *cold* burst: 25 simultaneous requests would all miss and all query,
 * which is the exact failure measured above. Sharing one promise collapses
 * them to a single round-trip.
 *
 * But the memo is per *instance*, and that is not enough on its own -- proven
 * by deploying it and re-running the burst: still 22 of 25 failing, because
 * the platform spreads 25 concurrent requests across many cold instances, each
 * with an empty memo and its own pool. Instances times pool size is what
 * exhausts the slots, not queries per request.
 *
 * So the response also carries `s-maxage`, which lets the CDN answer repeats
 * without invoking the function at all. That is the part that actually fixes
 * the burst; the memo below then covers the narrower case of one warm instance
 * serving concurrent requests between CDN revalidations. `force-dynamic`
 * governs Next's own caching and does not stop a CDN honouring these headers.
 */
export const dynamic = 'force-dynamic';

type Stats = {
  questions: number; subjects: number; pastPapers: number;
  resources: number; mockExams: number;
};

/** Counts move when a transcription or tagging pass lands -- daily at most. */
const STATS_TTL_MS = 5 * 60 * 1000;

/**
 * Let the CDN serve repeats. `stale-while-revalidate` keeps it answering from
 * the edge while one request refreshes behind it, so even the revalidation
 * moment is not a stampede.
 */
const CDN_CACHE = 'public, s-maxage=300, stale-while-revalidate=600';
let cached: { at: number; value: Stats } | null = null;
let inFlight: Promise<Stats> | null = null;

/**
 * The numbers on the signed-out landing page.
 *
 * These are the first claims a stranger sees about the platform, so each one
 * has to survive being checked. Three of the five were previously wrong in a
 * way that flattered the product:
 *
 *  - `questions` counted `PastPaperQuestion`, the **legacy** 12.4k text corpus,
 *    and ignored the 66,756 published crop-first bank questions that are what
 *    students actually practise on. It undersold the corpus by a factor of
 *    five while naming the wrong thing.
 *  - `resources` added `sharedNote`, a table whose only writer was deleted with
 *    the community-notes feature. It can only ever count rows that predate the
 *    removal, and it trends to a number nothing can increase.
 *  - `subjects` and `pastPapers` counted the legacy catalogue for the same
 *    reason as `questions`.
 *
 * Every count below is now restricted to content a signed-in student can
 * actually reach: `published` bank questions only (the `needs_review` queue is
 * held back from browsing, so counting it would be a promise the app does not
 * keep), and subjects that have at least one such question.
 */
async function loadStats(): Promise<Stats> {
  const [questions, subjects, pastPapers, resources, mockExams] = await Promise.all([
    prisma.bankQuestion.count({ where: { status: 'published' } }),
    // Distinct syllabus codes, through papers. A `bank_subjects` row is
    // (board, code, level), so counting rows double-counts a syllabus taught
    // at two levels -- and disagrees with the figure `lib/feature-readiness.ts`
    // states on the same page. Going through papers also means a subject
    // whose every question is still in review is not counted as "covered".
    prisma.bankSubject
      .findMany({
        where: { papers: { some: { questions: { some: { status: 'published' } } } } },
        select: { code: true },
        distinct: ['code'],
      })
      .then((rows) => rows.length),
    prisma.bankPaper.count({ where: { docType: 'qp' } }),
    prisma.schoolResource.count(),
    prisma.mockExam.count(),
  ]);
  return { questions, subjects, pastPapers, resources, mockExams };
}

export async function GET() {
  const fresh = cached && Date.now() - cached.at < STATS_TTL_MS;
  if (fresh && cached) {
    return NextResponse.json(cached.value, { headers: { 'Cache-Control': CDN_CACHE } });
  }

  try {
    // Every concurrent miss awaits the same query rather than starting its own.
    // Cleared in `finally` so a failure does not pin a rejected promise here
    // and turn one bad moment into a permanently broken endpoint.
    inFlight ??= loadStats().finally(() => { inFlight = null; });
    const value = await inFlight;
    cached = { at: Date.now(), value };
    return NextResponse.json(value, { headers: { 'Cache-Control': CDN_CACHE } });
  } catch (error) {
    console.error('[platform-stats] error:', error);
    await reportError(error, { routePath: '/api/platform-stats', source: 'route' });
    // Stale figures beat a 500 for numbers this soft, and the whole reason
    // this route fails is that the database is already under pressure --
    // answering from memory is also the kinder thing to do to it.
    if (cached) {
      return NextResponse.json(cached.value, {
        // Deliberately a short CDN life on a stale answer: long enough to
        // shield the database through the incident, short enough that the
        // figures correct themselves soon after it passes.
        headers: { 'X-Stats-Stale': '1', 'Cache-Control': 'public, s-maxage=60' },
      });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch platform stats' },
      { status: 500 },
    );
  }
}
