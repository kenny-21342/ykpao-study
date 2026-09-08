/**
 * GET the log a joining client needs to reconstruct a page's live Yjs
 * document (Feature 5, flagged off by default via `isYjsCollabEnabled()`):
 * the latest compacted snapshot (if one exists) plus every update since
 * it, or since an explicit `?since=<updateId>` cursor for an already-synced
 * client that just wants what it missed.
 *
 * Returns base64-encoded bytes -- JSON has no binary type -- ordered oldest
 * first, the order Yjs's `Y.applyUpdate` expects them applied in.
 */
import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getPageAccess } from '@/lib/page-access';
import { isYjsCollabEnabled } from '@/lib/stream-config';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: RouteContext) {
  if (!isYjsCollabEnabled()) {
    return NextResponse.json({ error: 'Collaborative editing is not enabled' }, { status: 501 });
  }

  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: pageId } = await params;
  const access = await getPageAccess(pageId, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });

  const since = new URL(req.url).searchParams.get('since');

  // An explicit cursor means the client already has a synced doc and just
  // wants what changed after one specific update -- skip the snapshot
  // entirely rather than re-applying history it's already folded in.
  let snapshot: string | null = null;
  let updatesQuery: { pageId: string; createdAt?: { gt: Date } } = { pageId };

  if (since) {
    const cursor = await prisma.pageYjsUpdate.findUnique({
      where: { id: since },
      select: { createdAt: true, pageId: true },
    });
    if (cursor && cursor.pageId === pageId) {
      updatesQuery = { pageId, createdAt: { gt: cursor.createdAt } };
    }
    // An unknown/stale cursor (e.g. pruned by compaction) falls through to
    // the full snapshot + full log below rather than silently returning
    // nothing -- a client with no other way to catch up needs the whole
    // reconstruction, not a partial one it can't tell is partial.
  } else {
    const snap = await prisma.pageYjsSnapshot.findUnique({
      where: { pageId },
      select: { state: true },
    });
    // Bytes fields come back as Uint8Array (Prisma 7), not Node Buffer --
    // Buffer.from() over it gives back the base64-encoding API.
    if (snap) snapshot = Buffer.from(snap.state).toString('base64');
  }

  const updates = await prisma.pageYjsUpdate.findMany({
    where: updatesQuery,
    orderBy: { createdAt: 'asc' },
    select: { id: true, data: true },
  });

  return NextResponse.json({
    snapshot,
    updates: updates.map((u) => ({ id: u.id, data: Buffer.from(u.data).toString('base64') })),
  });
}
