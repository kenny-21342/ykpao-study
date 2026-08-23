import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { indexSharedNote, refreshRagIndex } from '@/lib/rag-index';
import { resolveCourseScope } from '@/lib/course-scope';
import { LearnerContextError } from '@/lib/learner-context';
import { parsePositiveInt } from '@/lib/query-params';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

// GET /api/shared-notes — browse public shared notes (Resource Library)
// Optional query: ?subject=&courseCode=&tag=&q=&page=&limit=
// Also returns the distinct list of subjects in use for the filter dropdown.
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const subject = searchParams.get('subject')?.trim() || undefined;
    const courseCode = searchParams.get('courseCode') || undefined;
    const tag = searchParams.get('tag') || undefined;
    const q = searchParams.get('q')?.trim() || undefined;
    const page = parsePositiveInt(searchParams.get('page'), 1);
    const limit = parsePositiveInt(searchParams.get('limit'), 24, 50);
    const user = await getSessionUser();
    // `resolveCourseScope` is a preference filter and says so -- it resolves
    // "enrolled" vs "all" without changing authorization, so it answers
    // `effectiveScope: 'all'` for a caller with no user id. That is correct for
    // what it does and wrong as the only thing between an anonymous request and
    // every row. Authorization belongs here, ahead of it. `visibility: 'public'` means
    // public to the school, not public to the internet.
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const courseScope = await resolveCourseScope({ userId: user.id, scope: searchParams.get('scope'), courseId: searchParams.get('courseId') });

    const where = {
      visibility: 'public' as const,
      ...(subject ? { subject: courseScope.effectiveScope === 'enrolled' && !courseScope.subjects.includes(subject) ? '__no_matching_enrolled_course__' : subject } : {}),
      ...(courseCode ? { courseCode: courseScope.effectiveScope === 'enrolled' && ![...courseScope.subjectCodes, ...courseScope.courseCodes].includes(courseCode) ? '__no_matching_enrolled_course__' : courseCode } : {}),
      ...(tag ? { tags: { has: tag } } : {}),
      AND: [
        ...(!subject && !courseCode && courseScope.effectiveScope === 'enrolled' ? [{ OR: [
          { subject: { in: courseScope.subjects } },
          { courseCode: { in: [...courseScope.subjectCodes, ...courseScope.courseCodes] } },
        ] }] : []),
        ...(q ? [{
          OR: [
              { title: { contains: q, mode: 'insensitive' as const } },
              { content: { contains: q, mode: 'insensitive' as const } },
          ],
        }] : []),
      ],
    };

    // Distinct subjects for the filter dropdown (run in parallel with the
    // paged query so it costs no extra latency).
    const [total, notes, subjects] = await Promise.all([
      prisma.sharedNote.count({ where }),
      prisma.sharedNote.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, name: true, image: true } },
          _count: { select: { comments: true, ratings: true } },
        },
      }),
      prisma.sharedNote.findMany({
        where: { subject: { not: null } },
        distinct: ['subject'],
        select: { subject: true },
        orderBy: { subject: 'asc' },
      }),
    ]);

    return NextResponse.json({
      notes: notes.map((n) => ({
        id: n.id,
        title: n.title,
        content: n.content,
        subject: n.subject,
        courseCode: n.courseCode,
        tags: n.tags,
        visibility: n.visibility,
        attachments: n.attachments,
        views: n.views,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        author: n.user,
        commentCount: n._count.comments,
        ratingCount: n._count.ratings,
      })),
      subjects: subjects.map((s) => s.subject).filter((s): s is string => s != null),
      total,
      page,
      totalPages: Math.ceil(total / limit),
      scope: courseScope,
    });
  } catch (error) {
    if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('Failed to list shared notes:', error);
    await reportError(error, { routePath: '/api/shared-notes', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list shared notes' },
      { status: 500 }
    );
  }
}

// POST /api/shared-notes — publish a new shared note
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) ?? {};
    const { title, content, subject, courseCode, tags, visibility, attachments } = body as {
      title?: string;
      content?: string;
      subject?: string;
      courseCode?: string;
      tags?: string[];
      visibility?: string;
      attachments?: unknown;
    };

    if (!title?.trim() || !content?.trim()) {
      return NextResponse.json({ error: 'title and content are required' }, { status: 400 });
    }

    // Normalize attachments: only objects with an allowed /uploads/* URL survive.
    const safeAttachments = normalizeAttachments(attachments);

    const note = await prisma.sharedNote.create({
      data: {
        userId: user.id,
        title: title.trim(),
        content,
        subject: subject?.trim() || null,
        courseCode: courseCode?.trim() || null,
        tags: tags ?? [],
        visibility: visibility === 'private' ? 'private' : 'public',
        attachments: safeAttachments as unknown as Prisma.InputJsonValue,
      },
      include: {
        user: { select: { id: true, name: true, image: true } },
      },
    });
    await refreshRagIndex(`shared-note:${note.id}`, () => indexSharedNote(note.id));

    return NextResponse.json({ note }, { status: 201 });
  } catch (error) {
    console.error('Failed to create shared note:', error);
    await reportError(error, { routePath: '/api/shared-notes', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create shared note' },
      { status: 500 }
    );
  }
}

// Whitelist attachment payloads: must be {url,name,type,size} with a url
// pointing at our own /uploads/files/* path (images live inline in content).
const MAX_ATTACHMENTS = 20;
function normalizeAttachments(raw: unknown): Array<{ url: string; name: string; type: string; size: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ url: string; name: string; type: string; size: number }> = [];
  for (const item of raw) {
    if (out.length >= MAX_ATTACHMENTS) break;
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    const url = typeof a.url === 'string' ? a.url : '';
    // Only accept files served from our own uploads dir; reject paths that
    // could escape (..) or point elsewhere (http, absolute disk paths).
    if (!url.startsWith('/uploads/files/') || url.includes('..')) continue;
    const name = typeof a.name === 'string' ? a.name.slice(0, 200) : url.split('/').pop() ?? 'file';
    const type = typeof a.type === 'string' ? a.type.slice(0, 100) : 'application/octet-stream';
    const size = typeof a.size === 'number' && Number.isFinite(a.size) ? a.size : 0;
    out.push({ url, name, type, size });
  }
  return out;
}
