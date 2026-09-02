import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { parseGradeBoundaryCsv } from '@/lib/grade-boundary-import';

export const dynamic = 'force-dynamic';

/**
 * Grade thresholds, uploaded by an administrator.
 *
 * CAIE publishes its thresholds per session, so those can be entered as
 * `published`. The IB does not publish them -- a school receives its own
 * figures -- so those are `school`. Both are real; an `estimate` is what the
 * app falls back to when neither is on file, and the result screen says so.
 *
 * `source` is taken from the request, not the file, and is restricted to those
 * three values, so a spreadsheet cannot promote itself to official.
 */

const uploadSchema = z.object({
  csv: z.string().min(1).max(2_000_000),
  source: z.enum(['published', 'school', 'estimate']),
  /** Preview without writing. The client uses this to show errors first. */
  dryRun: z.boolean().default(false),
});

/** GET: what is on file, so an admin can see coverage before uploading more. */
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const grouped = await prisma.gradeBoundary.groupBy({
    by: ['board', 'subjectCode', 'year', 'session', 'source'],
    _count: { _all: true },
    orderBy: [{ board: 'asc' }, { subjectCode: 'asc' }, { year: 'desc' }],
  });

  return NextResponse.json({
    coverage: grouped.map((row) => ({
      board: row.board,
      subjectCode: row.subjectCode,
      year: row.year,
      session: row.session,
      source: row.source,
      boundaries: row._count._all,
    })),
  });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: z.infer<typeof uploadSchema>;
  try {
    body = uploadSchema.parse(await req.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid request' },
      { status: 400 },
    );
  }

  const { rows, errors } = parseGradeBoundaryCsv(body.csv, body.source);

  // Nothing is written when the file has any problem in it. A partial import
  // is the worst outcome: some papers graded against real thresholds and
  // others against estimates, with no way to tell which from the result screen.
  if (errors.length > 0) {
    return NextResponse.json(
      { applied: false, parsed: rows.length, errors },
      { status: rows.length > 0 ? 422 : 400 },
    );
  }
  if (body.dryRun) {
    return NextResponse.json({ applied: false, parsed: rows.length, errors: [] });
  }

  // Find-then-write rather than upsert: the identity tuple contains nullable
  // columns (level, year, session, paperNumber), and Prisma cannot key a
  // compound unique on a null. Postgres treats NULLs as distinct too, so the
  // unique index alone would let a second copy of a subject-wide row in.
  //
  // Re-uploading a corrected table therefore replaces the thresholds rather
  // than stacking a second set beside the wrong ones.
  let written = 0;
  let updated = 0;
  for (const row of rows) {
    const existing = await prisma.gradeBoundary.findFirst({
      where: {
        board: row.board,
        subjectCode: row.subjectCode,
        level: row.level,
        year: row.year,
        session: row.session,
        paperNumber: row.paperNumber,
        grade: row.grade,
      },
      select: { id: true },
    });
    if (existing) {
      await prisma.gradeBoundary.update({
        where: { id: existing.id },
        data: { minMark: row.minMark, totalMarks: row.totalMarks, source: row.source },
      });
      updated += 1;
    } else {
      await prisma.gradeBoundary.create({ data: row });
      written += 1;
    }
  }

  return NextResponse.json({ applied: true, parsed: rows.length, written, updated, errors: [] });
}
