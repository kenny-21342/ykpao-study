import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { parsePositiveInt } from '@/lib/query-params';

export const dynamic = 'force-dynamic';

// GET /api/notifications — list the current user's notifications.
// Query: ?unread=1 to fetch only unread, ?page=&limit= for pagination.
export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { searchParams } = new URL(req.url);
    const onlyUnread = searchParams.get('unread') === '1';
    const page = parsePositiveInt(searchParams.get('page'), 1);
    const limit = parsePositiveInt(searchParams.get('limit'), 30, 50);

    const where = {
      userId: user.id,
      ...(onlyUnread ? { read: false } : {}),
    };

    const [total, unreadCount, notifications] = await Promise.all([
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId: user.id, read: false } }),
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          actor: { select: { id: true, name: true, image: true } },
        },
      }),
    ]);

    return NextResponse.json({
      notifications: notifications.map((n) => ({
        id: n.id,
        type: n.type,
        entityId: n.entityId,
        entityUrl: n.entityUrl,
        title: n.title,
        body: n.body,
        read: n.read,
        createdAt: n.createdAt,
        actor: n.actor,
      })),
      total,
      unreadCount,
      page,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Failed to list notifications:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list notifications' },
      { status: 500 }
    );
  }
}

// PATCH /api/notifications — mark notifications as read.
// Body:
//   { id: "<notificationId>" }        mark one as read
//   { all: true }                      mark all as read
//   { ids: ["a","b"] }                 mark several as read
export async function PATCH(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = (await req.json()) ?? {};
    const { id, ids, all } = body as { id?: string; ids?: string[]; all?: boolean };

    if (all) {
      const r = await prisma.notification.updateMany({
        where: { userId: user.id, read: false },
        data: { read: true },
      });
      return NextResponse.json({ ok: true, updated: r.count });
    }

    const targetIds = id ? [id] : Array.isArray(ids) ? ids : [];
    if (targetIds.length === 0) {
      return NextResponse.json({ error: 'id, ids, or all is required' }, { status: 400 });
    }

    const r = await prisma.notification.updateMany({
      // The userId clause scopes the update so a user can't mark someone
      // else's notification as read by guessing its id.
      where: { userId: user.id, id: { in: targetIds } },
      data: { read: true },
    });
    return NextResponse.json({ ok: true, updated: r.count });
  } catch (error) {
    console.error('Failed to mark notifications as read:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to mark notifications' },
      { status: 500 }
    );
  }
}
