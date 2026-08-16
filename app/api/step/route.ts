import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUser } from '@/lib/auth';
import { parsePositiveInt } from '@/lib/query-params';

export const dynamic = 'force-dynamic';

/**
 * GET /api/step
 *
 * Returns STEP (and future competition) questions, but ONLY if the current
 * user has unlocked the competition vault. Without the unlock, this endpoint
 * always returns 404 — so a locked user can't even discover the questions
 * exist by poking the URL.
 *
 * Query:
 *   ?q=<text>      search across code + labels (case-insensitive)
 *   ?paper=S1      filter by paper
 *   ?year=16       filter by year label
 *   ?page=&limit=  pagination (default 50 / max 200)
 *   ?id=<code>     fetch a single question by code (e.g. "16-S1-Q1")
 */
const COMPETITION_KEY = 'competition';

export async function GET(req: NextRequest) {
  // ---- Unlock gate ----
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!(user.unlocks ?? []).includes(COMPETITION_KEY)) {
    // Pretend the resource doesn't exist — keeps the easter egg hidden.
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim() ?? '';
  const paper = searchParams.get('paper');
  const year = searchParams.get('year');
  const page = parsePositiveInt(searchParams.get('page'), 1);
  const limit = parsePositiveInt(searchParams.get('limit'), 50, 200);
  const id = searchParams.get('id');

  // ---- Single question by code ----
  if (id) {
    const question = await prisma.competitionQuestion.findUnique({
      where: { competition_code: { competition: 'STEP', code: id } },
    });
    if (!question) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ question });
  }

  // ---- Build where clause ----
  // For label search we need substring matching (typing "ineq" should match
  // "Inequalities"). Prisma's array filters (`has`/`hasSome`) only do exact
  // element equality, so for the text query we drop into raw SQL; for the
  // non-search path we can use the clean Prisma builder.
  const where: Record<string, unknown> = { competition: 'STEP' };
  if (paper) where.paper = paper;
  if (year) where.yearLabel = year;

  if (q) {
    // Substring search across code AND any label element (case-insensitive).
    // Postgres: `array_to_string(labels, ' ') ILIKE '%q%'` collapses the array
    // so a single ILIKE covers every label; `code ILIKE` covers the code.
    // We use raw SQL because Prisma's array filters (`has`/`hasSome`) only do
    // exact element equality — typing "ineq" wouldn't match "Inequalities".
    const pattern = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`;
    const offset = (page - 1) * limit;
    // $1=pattern, $2=paper|NULL, $3=year|NULL (LIMIT/OFFSET inlined as safe ints).
    const baseParams = [pattern, paper ?? null, year ?? null];

    const [questions, countRows] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT * FROM competition_questions
         WHERE competition = 'STEP'
           AND ($2 IS NULL OR paper = $2)
           AND ($3 IS NULL OR "yearLabel" = $3)
           AND (code ILIKE $1 OR array_to_string(labels, ' ') ILIKE $1)
         ORDER BY
           CASE "yearLabel" WHEN 'Spec' THEN 0 ELSE 1 END,
           paper ASC, number ASC
         LIMIT ${limit} OFFSET ${offset}`,
        ...baseParams,
      ) as Promise<Record<string, unknown>[]>,
      prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count FROM competition_questions
         WHERE competition = 'STEP'
           AND ($2 IS NULL OR paper = $2)
           AND ($3 IS NULL OR "yearLabel" = $3)
           AND (code ILIKE $1 OR array_to_string(labels, ' ') ILIKE $1)`,
        ...baseParams,
      ) as Promise<{ count: number }[]>,
    ]);

    const total = countRows[0]?.count ?? 0;
    return NextResponse.json({
      questions,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  }

  const [total, questions] = await Promise.all([
    prisma.competitionQuestion.count({ where }),
    prisma.competitionQuestion.findMany({
      where,
      orderBy: [{ yearLabel: 'asc' }, { paper: 'asc' }, { number: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
      // For the list view, return everything — the body is small.
    }),
  ]);

  return NextResponse.json({
    questions,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
}
