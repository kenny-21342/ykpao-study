import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { parsePositiveInt } from '@/lib/query-params';
import { deleteSchoolResource } from '@/lib/school-resources';
import { indexDiscussionThread, refreshRagIndex } from '@/lib/rag-index';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/content?type=threads|posts|resources&page=
 * Browse user-generated content for moderation.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type') ?? 'threads';
  const page = parsePositiveInt(searchParams.get('page'), 1);
  const pageSize = parsePositiveInt(searchParams.get('pageSize'), 20, 50);
  const q = searchParams.get('q')?.trim();

  const skip = (page - 1) * pageSize;
  const orderBy = { createdAt: 'desc' as const };

  if (type === 'threads') {
    const where = q ? { OR: [{ title: { contains: q, mode: 'insensitive' as const } }, { content: { contains: q, mode: 'insensitive' as const } }] } : {};
    const [items, total] = await Promise.all([
      prisma.discussionThread.findMany({ where, include: { user: { select: { name: true, email: true } }, _count: { select: { posts: true } } }, orderBy, skip, take: pageSize }),
      prisma.discussionThread.count({ where }),
    ]);
    return NextResponse.json({ items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  }

  if (type === 'posts') {
    const where = q ? { content: { contains: q, mode: 'insensitive' as const } } : {};
    const [items, total] = await Promise.all([
    prisma.discussionPost.findMany({ where, include: { user: { select: { name: true, email: true } }, thread: { select: { id: true, title: true } } }, orderBy, skip, take: pageSize }),
      prisma.discussionPost.count({ where }),
    ]);
    return NextResponse.json({ items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  }

  if (type === 'resources') {
    const where = q ? { OR: [{ title: { contains: q, mode: 'insensitive' as const } }, { description: { contains: q, mode: 'insensitive' as const } }] } : {};
    const [items, total] = await Promise.all([
      prisma.schoolResource.findMany({ where, include: { uploader: { select: { name: true, email: true } } }, orderBy, skip, take: pageSize }),
      prisma.schoolResource.count({ where }),
    ]);
    return NextResponse.json({ items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
  }

  return NextResponse.json({ error: 'Unknown content type' }, { status: 400 });
}

/**
 * DELETE /api/admin/content?type=&id=
 * Remove a piece of content.
 */
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type');
  const id = searchParams.get('id');
  if (!type || !id) return NextResponse.json({ error: 'type and id required' }, { status: 400 });

  // Every branch below has to reach the RAG index as well as the row. This is
  // the moderation path -- the one whose entire purpose is that content stops
  // being visible -- so leaving a deleted thread's title and body sitting in
  // global search, reachable by every user, is the worst place to miss it.
  if (type === 'threads') {
    await prisma.discussionThread.delete({ where: { id } });
    // Re-indexing a thread that no longer exists is how the indexer deletes:
    // it looks the thread up, finds nothing, and drops the document.
    await refreshRagIndex(`discussion-thread:${id}`, () => indexDiscussionThread(id));
  } else if (type === 'posts') {
    // A post is indexed as part of its thread's document, not on its own, so
    // the parent is what has to be rebuilt -- otherwise the deleted reply's
    // text stays searchable inside it.
    const post = await prisma.discussionPost.findUnique({ where: { id }, select: { threadId: true } });
    await prisma.discussionPost.delete({ where: { id } });
    if (post) {
      await refreshRagIndex(`discussion-thread:${post.threadId}`, () => indexDiscussionThread(post.threadId));
    }
  } else if (type === 'resources') {
    // Via the shared helper: the row deletion alone used to leave the stored
    // file on the bill and the resource's text alive in the RAG index.
    const result = await deleteSchoolResource(id);
    if (result.status === 'not-found') {
      return NextResponse.json({ error: 'Resource not found' }, { status: 404 });
    }
  }
  else return NextResponse.json({ error: 'Unknown content type' }, { status: 400 });

  return NextResponse.json({ success: true });
}

/**
 * PATCH /api/admin/content
 * Toggle thread pinned/locked, or other quick state changes.
 * Body: { type, id, action } where action is 'pin'|'unpin'|'lock'|'unlock'
 */
export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => null);
  if (!body?.type || !body?.id || !body?.action) {
    return NextResponse.json({ error: 'type, id, action required' }, { status: 400 });
  }
  const { type, id, action } = body;

  if (type === 'threads') {
    const data: Record<string, boolean> = {};
    if (action === 'pin') data.pinned = true;
    else if (action === 'unpin') data.pinned = false;
    else if (action === 'lock') data.locked = true;
    else if (action === 'unlock') data.locked = false;
    const updated = await prisma.discussionThread.update({ where: { id }, data });
    return NextResponse.json({ item: updated });
  }

  return NextResponse.json({ error: 'Unsupported type/action' }, { status: 400 });
}
