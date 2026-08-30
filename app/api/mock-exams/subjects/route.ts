/**
 * The subjects the mock-exam form is allowed to offer.
 *
 * The form used to fill its dropdown from `/api/questions?action=filters`,
 * which lists legacy `subjects` that have any *paper*. Papers exist for all
 * eight enrolled subjects; questions do not. So Additional Mathematics (0606)
 * was offered, chosen, and then refused by the generator -- the picker was
 * promising something the draw could not deliver.
 *
 * This route answers the narrower question the form actually needs: which of
 * the student's enrolled subjects have published questions with a published,
 * marked mark scheme behind them. It runs the generator's own predicate, so
 * the two cannot drift apart.
 */
import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { resolveCourseScope } from '@/lib/course-scope';
import { LearnerContextError } from '@/lib/learner-context';
import { toBankSubjectCodes } from '@/lib/bank-questions';
import { subjectNameForCode } from '@/lib/course-catalog';
import { listServableSubjects } from '@/lib/mock-exam-selection';
import { predictionPathsFor } from '@/lib/predicted-paper';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const scope = await resolveCourseScope({ userId: user.id });
    const enrolled = scope.effectiveScope === 'enrolled' ? scope.subjectCodes : null;

    // The bank stores IB subjects under a bare slug where the catalog uses an
    // `ib-` prefix, so the query is run over the expanded set and the answer
    // mapped back to the code the form has to submit.
    const servable = await listServableSubjects(enrolled ? toBankSubjectCodes(enrolled) : null);

    // A predicted paper is model-curated only where the legacy corpus has the
    // question text to curate. Everywhere else it is assembled from the bank,
    // and the form must not offer Topics or Difficulty for it.
    const paths = await predictionPathsFor(
      enrolled ?? servable.map((subject) => subject.code),
    );

    const subjects = enrolled
      ? enrolled
          .map((catalogCode) => {
            const bankCodes = toBankSubjectCodes([catalogCode]);
            const match = servable.find((s) => bankCodes.includes(s.code));
            if (!match) return null;
            // bank_subjects.name is derived from the filename, so it reads
            // "CAIE 0610". The catalog knows it as Biology.
            return {
              id: match.id,
              code: catalogCode,
              name: subjectNameForCode(catalogCode) ?? match.name,
              curatedPrediction: paths.get(catalogCode) === 'curated',
            };
          })
          .filter(
            (s): s is { id: number; code: string; name: string; curatedPrediction: boolean } =>
              s !== null,
          )
      : servable.map((s) => ({
          ...s,
          name: subjectNameForCode(s.code) ?? s.name,
          curatedPrediction: paths.get(s.code) === 'curated',
        }));

    return NextResponse.json({ subjects });
  } catch (error) {
    if (error instanceof LearnerContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    reportError(error, { routePath: '/api/mock-exams/subjects', routeType: 'route', method: 'GET' });
    return NextResponse.json({ error: 'Could not load subjects' }, { status: 500 });
  }
}
