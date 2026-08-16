import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// PUT /api/mock-exams/[id]/progress
// Save in-progress answers WITHOUT submitting/grading. Lets a user resume
// a timed exam after closing the tab. Body: { answers: { [itemId]: string } }
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;

    const exam = await prisma.mockExam.findFirst({
      where: { id, userId: user.id },
      select: { id: true, status: true },
    });
    if (!exam) {
      return NextResponse.json({ error: 'Mock exam not found' }, { status: 404 });
    }
    if (exam.status === 'completed') {
      return NextResponse.json(
        { error: 'Cannot save progress on a completed exam' },
        { status: 400 }
      );
    }

    const body = (await req.json()) ?? {};
    const answers = body.answers as Record<string, string> | undefined;
    if (!answers || typeof answers !== 'object') {
      return NextResponse.json({ error: 'answers object is required' }, { status: 400 });
    }

    // Update each item's answer. We only touch items that belong to this
    // exam (the where clause scopes by mockExamId) so a forged itemId from
    // another exam can't leak data.
    const entries = Object.entries(answers).filter(
      ([, v]) => typeof v === 'string'
    );

    // Bounded parallel writes — typical exams have < 30 items.
    await Promise.all(
      entries.map(([itemId, answer]) =>
        prisma.mockExamItem.updateMany({
          where: { id: itemId, mockExamId: id },
          data: { answer },
        })
      )
    );

    return NextResponse.json({ ok: true, saved: entries.length });
  } catch (error) {
    console.error('Failed to save exam progress:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save progress' },
      { status: 500 }
    );
  }
}
