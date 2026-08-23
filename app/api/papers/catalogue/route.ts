import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getSessionUser } from '@/lib/auth';
import { reportError } from '@/lib/error-reporting';
import {
  curriculumId,
  curriculumLabel,
  parseCurriculumId,
  sessionLabel,
  sessionOrder,
} from '@/lib/paper-catalogue';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  curriculum: z.string().trim().min(1).optional(),
  subject: z.string().trim().min(1).optional(),
  year: z.coerce.number().int().min(1990).max(2100).optional(),
});

/**
 * Options for the browse cascade: curriculum -> subject -> year -> series.
 *
 * Each step returns only what the filters so far allow, so the UI can never
 * offer a combination that has no papers behind it.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let query: z.infer<typeof QuerySchema>;
  try {
    query = QuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
  } catch (error) {
    return NextResponse.json(
      { error: 'Invalid filters', issues: error instanceof z.ZodError ? error.issues : undefined },
      { status: 400 },
    );
  }

  try {
    const curriculum = query.curriculum ? parseCurriculumId(query.curriculum) : null;
    if (query.curriculum && !curriculum) {
      return NextResponse.json({ error: 'Invalid curriculum' }, { status: 400 });
    }

    // Step 1 -- curricula, with a paper count each.
    const subjectRows = await prisma.subject.findMany({
      where: { papers: { some: {} } },
      select: {
        code: true,
        name: true,
        board: true,
        qualification: true,
        _count: { select: { papers: true } },
      },
      orderBy: { code: 'asc' },
    });

    const curriculaMap = new Map<
      string,
      { id: string; board: string; qualification: string; label: string; subjectCount: number; paperCount: number }
    >();
    for (const subject of subjectRows) {
      const id = curriculumId(subject.board, subject.qualification);
      const entry = curriculaMap.get(id) ?? {
        id,
        board: subject.board,
        qualification: subject.qualification,
        label: curriculumLabel(subject.board, subject.qualification),
        subjectCount: 0,
        paperCount: 0,
      };
      entry.subjectCount += 1;
      entry.paperCount += subject._count.papers;
      curriculaMap.set(id, entry);
    }
    const curricula = [...curriculaMap.values()].sort((a, b) => a.label.localeCompare(b.label));

    // Step 2 -- subjects within the chosen curriculum.
    const subjects = curriculum
      ? subjectRows
          .filter(
            (s) => s.board === curriculum.board && s.qualification === curriculum.qualification,
          )
          .map((s) => ({
            code: s.code,
            name: s.name,
            paperCount: s._count.papers,
          }))
          .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code))
      : [];

    const subjectRecord =
      curriculum && query.subject
        ? subjectRows.find(
            (s) =>
              s.code === query.subject &&
              s.board === curriculum.board &&
              s.qualification === curriculum.qualification,
          )
        : undefined;

    // Step 3 -- years available for that subject.
    const years = subjectRecord
      ? (
          await prisma.pastPaper.groupBy({
            by: ['year'],
            where: { subject: { code: subjectRecord.code } },
            _count: { _all: true },
          })
        )
          .map((row) => ({ year: row.year, paperCount: row._count._all }))
          .sort((a, b) => b.year - a.year)
      : [];

    // Step 4 -- exam series within that year.
    const sessions =
      subjectRecord && query.year !== undefined
        ? (
            await prisma.pastPaper.groupBy({
              by: ['session'],
              where: { subject: { code: subjectRecord.code }, year: query.year },
              _count: { _all: true },
            })
          )
            .map((row) => ({
              session: row.session,
              label: sessionLabel(row.session),
              paperCount: row._count._all,
            }))
            .sort((a, b) => sessionOrder(a.session) - sessionOrder(b.session))
        : [];

    return NextResponse.json({ curricula, subjects, years, sessions });
  } catch (error) {
    console.error('Failed to load paper catalogue:', error);
    await reportError(error, { routePath: '/api/papers/catalogue', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load catalogue' },
      { status: 500 },
    );
  }
}
