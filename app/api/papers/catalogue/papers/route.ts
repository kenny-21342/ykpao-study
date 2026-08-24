import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getSessionUser } from '@/lib/auth';
import { groupIntoInstances } from '@/lib/paper-catalogue';
import { reportError } from '@/lib/error-reporting';
import { publishedSubjectCodes } from '@/lib/course-catalog';

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({
  subject: z.string().trim().min(1),
  year: z.coerce.number().int().min(1990).max(2100),
  session: z.string().trim().min(1),
});

const PAPER_SELECT = {
  id: true,
  year: true,
  session: true,
  paperNumber: true,
  paperCode: true,
  variant: true,
  level: true,
  timezone: true,
  docType: true,
  filename: true,
  pageCount: true,
  sizeBytes: true,
  subject: { select: { code: true, name: true } },
} as const;

/**
 * Papers for one subject/year/series, grouped into exam sittings.
 *
 * A sitting is bounded (a few dozen documents at most), so the rows are grouped
 * in memory rather than with a windowed query.
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

  // Same restriction as the browse cascade. Filtering only the menu would
  // still serve an untaught subject to anyone who typed its code.
  if (!publishedSubjectCodes().has(query.subject)) {
    return NextResponse.json({ error: 'Unknown subject' }, { status: 404 });
  }

  try {
    const rows = await prisma.pastPaper.findMany({
      where: {
        subject: { code: query.subject },
        year: query.year,
        session: query.session,
      },
      select: PAPER_SELECT,
      orderBy: [{ paperNumber: 'asc' }, { variant: 'asc' }, { docType: 'asc' }],
    });

    return NextResponse.json({ instances: groupIntoInstances(rows) });
  } catch (error) {
    console.error('Failed to load papers:', error);
    await reportError(error, { routePath: '/api/papers/catalogue/papers', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load papers' },
      { status: 500 },
    );
  }
}
