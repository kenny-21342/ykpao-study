/**
 * Browsing the crop-first question bank.
 *
 * A sibling of /api/questions rather than a replacement for it. The two banks
 * derive from the same corpus but answer different jobs: the text bank feeds
 * everything that reasons over a question — AI grading, hints, `searchVector`
 * — and cannot be served by images, while this one is what a student actually
 * reads, because a crop of the original paper is faithful in a way a
 * transcription is not.
 *
 * The action names match /api/questions ('filters', 'questions', 'question')
 * so the Practice browser can source from either without changing shape.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { resolveCourseScope } from '@/lib/course-scope';
import { LearnerContextError } from '@/lib/learner-context';
import { parseIntList, parseZoneList } from '@/lib/bank-filter-clauses';
import { parsePositiveInt } from '@/lib/query-params';
import { reportError } from '@/lib/error-reporting';
import {
  getBankQuestion,
  getBankSubject,
  listBankFilters,
  listBankQuestions,
} from '@/lib/bank-questions';
import {
  conflictWithSubject, isEmptyQuery, parseQuestionQuery, type ParsedQuery,
} from '@/lib/bank-search';

export const dynamic = 'force-dynamic';

/** null means "every subject"; a list means "only these". */
function scopedSubjectCodes(scope: { effectiveScope: string; subjectCodes: string[] }) {
  return scope.effectiveScope === 'enrolled' ? scope.subjectCodes : null;
}

function intParam(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');
    const user = await getSessionUser();

    // A session is required, not merely consulted.
    //
    // The session used to be read only to *scope* the results, never to gate
    // them -- so an anonymous request fell outside `enrolled` scope, which
    // means "every subject", and could page through all 65,776 published
    // questions without an account. Being signed out granted broader access
    // than being signed in, which is the wrong way round for a school
    // platform heading into a closed beta.
    //
    // The crops themselves were never exposed (/bank_assets/* has always
    // answered 401), so this closes an enumerable catalogue rather than a
    // content leak. Found by the pre-launch sweep on 30 Aug 2026.
    if (!user) {
      return NextResponse.json(
        { error: 'Sign in to browse the question bank.' },
        { status: 401 },
      );
    }

    const courseScope = await resolveCourseScope({
      userId: user?.id,
      scope: searchParams.get('scope'),
      courseId: searchParams.get('courseId'),
    });
    const subjectCodes = scopedSubjectCodes(courseScope);

    if (action === 'filters') {
      // `subject` is the bank subject id the browser has selected; it narrows
      // the topic, year, session and paper lists. See `listBankFilters`.
      return NextResponse.json({
        ...(await listBankFilters(subjectCodes, searchParams.get('subject'))),
        scope: courseScope,
      });
    }

    if (action === 'question') {
      const questionId = intParam(searchParams.get('id'));
      if (!questionId) {
        return NextResponse.json({ error: 'Question ID required' }, { status: 400 });
      }

      const question = await getBankQuestion(questionId);
      if (!question) {
        return NextResponse.json({ error: 'Question not found' }, { status: 404 });
      }
      return NextResponse.json({ question });
    }

    // Default: a page of questions.
    const subjectId = intParam(searchParams.get('subject'));
    const limit = parsePositiveInt(searchParams.get('limit'), 20, 100);

    // Search by question code or keyword. It needs a subject, because a code is
    // only meaningful inside one (the same "1SL" exists in every IB subject) and
    // a keyword over the whole 66,000-question bank is the slow query this
    // route has been rewritten to avoid.
    const rawSearch = (searchParams.get('q') ?? '').trim().slice(0, 200);
    let search: ParsedQuery | null = null;
    if (rawSearch) {
      const parsed = parseQuestionQuery(rawSearch);
      if (!isEmptyQuery(parsed)) {
        if (!subjectId) {
          return NextResponse.json(
            { error: 'Choose a subject to search by question number.' },
            { status: 400 },
          );
        }
        const subject = await getBankSubject(subjectId);
        if (!subject) {
          return NextResponse.json({ error: 'Unknown subject.' }, { status: 400 });
        }
        // Say what is wrong instead of returning an empty list that reads as
        // "that question does not exist".
        const notice = conflictWithSubject(parsed, subject);
        if (notice) {
          return NextResponse.json({
            questions: [], total: 0, page: 1, limit, notice, scope: courseScope,
          });
        }
        search = parsed;
      }
    }

    const result = await listBankQuestions({
      subjectCodes,
      subjectId,
      search,
      year: intParam(searchParams.get('year')),
      session: searchParams.get('session') || null,
      // `paper` may be a comma list ("1,2"): papers are multi-select.
      paperNumbers: parseIntList(searchParams.get('paper'), 8, 0, 9),
      variants: parseIntList(searchParams.get('variant'), 6, 1, 9),
      timezones: parseZoneList(searchParams.get('tz')),
      levels: parseIntList(searchParams.get('levels'), 5, 1, 5),
      topic: searchParams.get('topic') || null,
      // Only a signed-in user has bookmarks; for anyone else the filter is a
      // no-op rather than an empty list, which would look like a broken page.
      bookmarkedBy: searchParams.get('bookmarked') === '1' && user ? user.id : null,
      page: parsePositiveInt(searchParams.get('page'), 1),
      limit,
    });

    return NextResponse.json({ ...result, scope: courseScope });
  } catch (error) {
    if (error instanceof LearnerContextError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    reportError(error, { routePath: '/api/bank/questions', routeType: 'route', method: 'GET' });
    return NextResponse.json({ error: 'Failed to load the question bank' }, { status: 500 });
  }
}
