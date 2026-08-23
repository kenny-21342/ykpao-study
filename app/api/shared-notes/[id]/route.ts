import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

// GET /api/shared-notes/[id] — fetch one shared note + increment views
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const note = await prisma.sharedNote.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, image: true } },
        comments: {
          orderBy: { createdAt: 'desc' },
          include: { user: { select: { id: true, name: true, image: true } } },
        },
        ratings: { select: { rating: true, userId: true } },
      },
    });

    if (!note) {
      return NextResponse.json({ error: 'Shared note not found' }, { status: 404 });
    }
    if (note.visibility !== 'public') {
      const user = await getSessionUser();
      if (!user || user.id !== note.userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
      }
    }

    // Increment views (fire-and-forget, non-blocking)
    await prisma.sharedNote.update({
      where: { id },
      data: { views: { increment: 1 } },
    });

    const ratingValues = note.ratings.map((r) => r.rating);
    const avgRating = ratingValues.length
      ? ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length
      : null;

    return NextResponse.json({
      note: {
        id: note.id,
        title: note.title,
        content: note.content,
        courseCode: note.courseCode,
        subject: note.subject,
        tags: note.tags,
        visibility: note.visibility,
        attachments: note.attachments,
        views: note.views + 1,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        author: note.user,
        comments: note.comments,
        ratings: note.ratings,
        avgRating,
        ratingCount: note.ratings.length,
      },
    });
  } catch (error) {
    console.error('Failed to fetch shared note:', error);
    await reportError(error, { routePath: '/api/shared-notes/[id]', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch shared note' },
      { status: 500 }
    );
  }
}
