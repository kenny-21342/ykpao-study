/**
 * Stars on crop-first bank questions.
 *
 * A sibling of /api/bookmarks rather than an extension of it. There are three
 * question tables and a foreign key can only point at one, so each has its own
 * bookmark table; sharing one would mean giving up referential integrity on
 * all three. The shapes match so the UI treats them the same way.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

const BookmarkBody = z.object({
  questionId: z.number().int().positive(),
  note: z.string().max(1000).optional(),
});

/**
 * GET /api/bank/bookmarks
 *
 * Returns just the starred question ids. The browser needs to know which rows
 * to draw a filled star on, and it already holds everything else about them --
 * sending the questions again would repeat the crop metadata for the whole
 * list on every page change.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const bookmarks = await prisma.bankQuestionBookmark.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    select: { questionId: true },
  });

  return NextResponse.json({ questionIds: bookmarks.map((row) => row.questionId) });
}

/** POST /api/bank/bookmarks — star a question. Body: { questionId, note? } */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof BookmarkBody>;
  try {
    body = BookmarkBody.parse(await req.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid bookmark' },
      { status: 400 },
    );
  }

  // Only a published question can be starred: anything else is either held
  // back by the crop QA or does not exist, and neither should end up in a
  // student's saved list.
  const question = await prisma.bankQuestion.findFirst({
    where: { id: body.questionId, status: 'published' },
    select: { id: true },
  });
  if (!question) return NextResponse.json({ error: 'Question not found' }, { status: 404 });

  try {
    // Upsert, not create: starring twice is the same intent as starring once,
    // and the unique index would otherwise turn a double-click into a 500.
    await prisma.bankQuestionBookmark.upsert({
      where: { userId_questionId: { userId: user.id, questionId: body.questionId } },
      update: { note: body.note },
      create: { userId: user.id, questionId: body.questionId, note: body.note },
    });
    return NextResponse.json({ bookmarked: true });
  } catch (error) {
    reportError(error, { routePath: '/api/bank/bookmarks', routeType: 'route', method: 'POST' });
    return NextResponse.json({ error: 'Could not save the bookmark' }, { status: 500 });
  }
}

/** DELETE /api/bank/bookmarks?questionId=123 — unstar a question. */
export async function DELETE(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const questionId = Number.parseInt(
    new URL(req.url).searchParams.get('questionId') || '',
    10,
  );
  if (!Number.isFinite(questionId) || questionId <= 0) {
    return NextResponse.json({ error: 'Question ID required' }, { status: 400 });
  }

  // deleteMany, not delete: removing a star that is not there is the state the
  // caller asked for, so it succeeds rather than 404ing on a double-click.
  await prisma.bankQuestionBookmark.deleteMany({
    where: { userId: user.id, questionId },
  });

  return NextResponse.json({ bookmarked: false });
}
