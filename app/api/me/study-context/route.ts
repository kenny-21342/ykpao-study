import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { getLearnerContext, LearnerContextError } from '@/lib/learner-context';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const params = new URL(req.url).searchParams;
  try {
    const context = await getLearnerContext({
      userId: user.id,
      explicitCourseId: params.get('courseId'),
      pageCourseId: params.get('pageCourseId'),
      pageSubjectCode: params.get('pageSubjectCode'),
      conversationId: params.get('conversationId'),
      prompt: params.get('prompt')?.slice(0, 500),
    });
    return NextResponse.json({ context });
  } catch (error) {
    if (error instanceof LearnerContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
