import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { DISCUSSION_LABEL_SLUGS } from '@/lib/discussion-labels';
import { parsePositiveInt } from '@/lib/query-params';

export const dynamic = 'force-dynamic';

// GET /api/discussions/threads?category=&page=&limit=&q=
// subjectId filter is still supported for backward compatibility.
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const subjectId = searchParams.get('subjectId');
    const category = searchParams.get('category')?.trim() || undefined;
    const q = searchParams.get('q')?.trim() || undefined;
    const page = parsePositiveInt(searchParams.get('page'), 1);
    const limit = parsePositiveInt(searchParams.get('limit'), 20, 50);

    const where = {
      ...(subjectId ? { subjectId: Number(subjectId) } : {}),
      ...(category ? { category } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' as const } },
              { content: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [total, threads] = await Promise.all([
      prisma.discussionThread.count({ where }),
      prisma.discussionThread.findMany({
        where,
        orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, name: true, image: true } },
          subject: { select: { id: true, code: true, name: true } },
          _count: { select: { posts: true } },
        },
      }),
    ]);

    return NextResponse.json({
      threads: threads.map((t) => ({
        id: t.id,
        subjectId: t.subjectId,
        category: t.category,
        title: t.title,
        content: t.content,
        pinned: t.pinned,
        locked: t.locked,
        views: t.views,
        replyCount: t._count.posts,
        author: t.user,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Failed to list threads:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list threads' },
      { status: 500 }
    );
  }
}

const CreateBody = z.object({
  subjectId: z.number().int().positive().optional(),
  category: z
    .enum(DISCUSSION_LABEL_SLUGS as [string, ...string[]])
    .optional()
    .or(z.literal('')),
  title: z.string().trim().min(1, 'Title is required').max(200),
  content: z.string().max(20000).optional().default(''),
});

// POST /api/discussions/threads — create a thread in the general forum
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let parsed;
    try {
      parsed = CreateBody.parse(await req.json());
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Invalid request' },
        { status: 400 }
      );
    }

    const thread = await prisma.discussionThread.create({
      data: {
        subjectId: parsed.subjectId ?? null,
        category: parsed.category || null,
        userId: user.id,
        title: parsed.title,
        content: parsed.content ?? '',
      },
      include: {
        user: { select: { id: true, name: true, image: true } },
      },
    });

    return NextResponse.json({ thread }, { status: 201 });
  } catch (error) {
    console.error('Failed to create thread:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create thread' },
      { status: 500 }
    );
  }
}
