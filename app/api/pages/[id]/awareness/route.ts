import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getPageAccess, canEditPage } from '@/lib/page-access';
import { notifyAwareness, type AwarenessPayload } from '@/lib/page-pubsub';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const AwarenessUpdate = z.object({
  cursorFrom: z.number().int().nonnegative().nullish(),
  cursorTo: z.number().int().nonnegative().nullish(),
  typing: z.boolean().optional(),
});

/**
 * POST /api/pages/[id]/awareness
 *
 * Updates the caller's awareness state (cursor position, typing indicator)
 * and broadcasts it to other editors on the page via Postgres NOTIFY.
 *
 * The client should throttle this to ~5 messages/sec (every 200ms) — the
 * server does no rate-limiting beyond the natural DB write cost.
 *
 * Editors and owners can broadcast awareness; viewers cannot (they should
 * still connect to the SSE stream to *receive* awareness, but can't push
 * their own cursor).
 */
export async function POST(req: Request, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: pageId } = await params;
  const access = await getPageAccess(pageId, user.id);
  if (!access) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }
  if (!canEditPage(access.role)) {
    return NextResponse.json({ error: 'Viewers cannot broadcast awareness' }, { status: 403 });
  }

  let parsed: z.infer<typeof AwarenessUpdate>;
  try {
    parsed = AwarenessUpdate.parse(await req.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid awareness update' },
      { status: 400 }
    );
  }

  const now = new Date();
  const cursorFrom = parsed.cursorFrom ?? null;
  const cursorTo = parsed.cursorTo ?? null;
  const typing = parsed.typing ?? false;

  // Persist + broadcast in parallel — the NOTIFY fans out to SSE listeners
  // on whatever serverless instance they're connected to.
  const userColor = pickUserColor(user.id);
  const payload: AwarenessPayload = {
    userId: user.id,
    userName: user.name ?? null,
    userImage: user.image ?? null,
    userColor,
    cursorFrom,
    cursorTo,
    typing,
  };

  await Promise.all([
    prisma.pageAwareness.upsert({
      where: { pageId_userId: { pageId, userId: user.id } },
      create: { pageId, userId: user.id, cursorFrom, cursorTo, typing, lastSeenAt: now },
      update: { cursorFrom, cursorTo, typing, lastSeenAt: now },
    }),
    notifyAwareness(pageId, payload).catch(() => {
      // NOTIFY is best-effort; if it fails the SSE stream will still pick up
      // the change on its next presence poll.
    }),
  ]);

  return NextResponse.json({ ok: true });
}

const CURSOR_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
];

function pickUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}
