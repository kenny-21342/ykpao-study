import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * GET /api/bookmarks
 *   Returns the signed-in user's starred past-paper questions.
 *   Each item includes the question + paper metadata for display.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const bookmarks = await prisma.pastPaperBookmark.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    include: {
      question: {
        include: {
          paper: { include: { subject: true } },
        },
      },
    },
  });

  return NextResponse.json({
    bookmarks: bookmarks.map((b) => ({
      id: b.id,
      note: b.note,
      createdAt: b.createdAt,
      question: {
        id: b.question.id,
        number: b.question.number,
        part: b.question.part,
        sub_part: b.question.subPart,
        content: b.question.content,
        marks: b.question.marks,
        topic: b.question.topic,
        has_diagram: b.question.hasDiagram,
        year: b.question.paper.year,
        session: b.question.paper.session,
        paper_number: b.question.paper.paperNumber,
        variant: b.question.paper.variant,
        subject_name: b.question.paper.subject.name,
        subject_code: b.question.paper.subject.code,
      },
    })),
  });
}

const Body = z.object({
  questionId: z.number().int().positive(),
  note: z.string().max(1000).optional(),
});

/**
 * POST /api/bookmarks — star a question
 *   Body: { questionId: number, note?: string }
 *   Idempotent (returns existing bookmark if already starred).
 */
export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request' },
      { status: 400 }
    );
  }

  // Verify the question exists.
  const q = await prisma.pastPaperQuestion.findUnique({
    where: { id: parsed.questionId },
    select: { id: true },
  });
  if (!q) {
    return NextResponse.json({ error: 'Question not found' }, { status: 404 });
  }

  const bookmark = await prisma.pastPaperBookmark.upsert({
    where: {
      userId_questionId: { userId: user.id, questionId: parsed.questionId },
    },
    create: {
      userId: user.id,
      questionId: parsed.questionId,
      note: parsed.note,
    },
    update: {
      note: parsed.note,
    },
  });

  return NextResponse.json({ ok: true, bookmark }, { status: 201 });
}

/**
 * DELETE /api/bookmarks?questionId=123 — unstar a question
 */
export async function DELETE(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const questionId = parseInt(searchParams.get('questionId') || '0', 10);
  if (!questionId) {
    return NextResponse.json({ error: 'questionId is required' }, { status: 400 });
  }

  await prisma.pastPaperBookmark.deleteMany({
    where: { userId: user.id, questionId },
  });

  return NextResponse.json({ ok: true });
}
