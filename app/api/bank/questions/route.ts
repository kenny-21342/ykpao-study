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
import { parsePositiveInt } from '@/lib/query-params';
import { reportError } from '@/lib/error-reporting';
import {
  getBankQuestion,
  listBankFilters,
  listBankQuestions,
} from '@/lib/bank-questions';

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
      return NextResponse.json({
        ...(await listBankFilters(subjectCodes)),
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
    const result = await listBankQuestions({
      subjectCodes,
      subjectId: intParam(searchParams.get('subject')),
      year: intParam(searchParams.get('year')),
      session: searchParams.get('session') || null,
      paperNumber: intParam(searchParams.get('paper')),
      topic: searchParams.get('topic') || null,
      // Only a signed-in user has bookmarks; for anyone else the filter is a
      // no-op rather than an empty list, which would look like a broken page.
      bookmarkedBy: searchParams.get('bookmarked') === '1' && user ? user.id : null,
      page: parsePositiveInt(searchParams.get('page'), 1),
      limit: parsePositiveInt(searchParams.get('limit'), 20, 100),
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
