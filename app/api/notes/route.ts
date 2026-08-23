import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { indexNote, refreshRagIndex } from '@/lib/rag-index';
import { resolveCourseScope } from '@/lib/course-scope';
import { getLearnerContext, LearnerContextError } from '@/lib/learner-context';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

// GET /api/notes — list the authenticated user's notes
export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const params = new URL(req.url).searchParams;
    const courseScope = await resolveCourseScope({ userId: user.id, scope: params.get('scope'), courseId: params.get('courseId') });
    const preferenceFilter = courseScope.effectiveScope === 'enrolled' ? { OR: [{ courseId: { in: courseScope.courseIds } }, { courseId: null }] } : {};

    // Notes the user owns OR collaborates on. Owned notes are in `userId`;
    // collaborated notes come through the `collaborators` relation. We return
    // a single flat array (owned first, then shared) for backward-compat with
    // existing clients that do `setNotes(data)` directly. Each shared note is
    // tagged with `_shared: true` and `_role` so the UI can badge it.
    const [ownedNotes, collabNotes] = await Promise.all([
      prisma.note.findMany({
        where: { userId: user.id, ...preferenceFilter },
        include: {
          folder: true,
          collaborators: {
            include: { user: { select: { id: true, name: true, image: true } } },
          },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.note.findMany({
        where: { collaborators: { some: { userId: user.id } }, ...preferenceFilter },
        include: {
          folder: true,
          user: { select: { id: true, name: true, image: true } },
          collaborators: {
            include: { user: { select: { id: true, name: true, image: true } } },
          },
        },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    const shared = collabNotes.map((n) => {
      const me = n.collaborators.find((c) => c.userId === user.id);
      return { ...n, _shared: true, _role: me?.role ?? 'viewer' };
    });

    return NextResponse.json([...ownedNotes, ...shared]);
  } catch (error) {
    if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('Failed to list notes:', error);
    await reportError(error, { routePath: '/api/notes', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list notes' },
      { status: 500 }
    );
  }
}

// POST /api/notes — create a note
// Accepts { title, content, tags?, subject? }. The legacy `subject` field is
// folded into tags (the Note model has no subject column).
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) ?? {};
    const { title, content, subject, tags, courseId } = body as {
      title?: string;
      content?: string;
      subject?: string;
      tags?: string[];
      courseId?: string;
    };

    if (!title?.trim()) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }
    if (courseId) {
      try { await getLearnerContext({ userId: user.id, explicitCourseId: courseId }); }
      catch (error) { if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status }); throw error; }
    }

    const tagList = Array.isArray(tags) ? tags.filter(Boolean) : [];
    if (subject?.trim() && !tagList.includes(subject.trim())) {
      tagList.push(subject.trim());
    }

    const note = await prisma.note.create({
      data: {
        title: title.trim(),
        content: content ?? '',
        tags: tagList,
        userId: user.id,
        courseId: courseId || null,
      },
    });
    await refreshRagIndex(`note:${note.id}`, () => indexNote(note.id));

    return NextResponse.json(note, { status: 201 });
  } catch (error) {
    console.error('Failed to create note:', error);
    await reportError(error, { routePath: '/api/notes', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create note' },
      { status: 500 }
    );
  }
}
