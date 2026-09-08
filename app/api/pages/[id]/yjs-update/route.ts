/**
 * POST one Yjs update for a page's collaborative session (Feature 5,
 * flagged off by default via `isYjsCollabEnabled()`).
 *
 * The update bytes are appended to `PageYjsUpdate` and never touch
 * `Page.content` -- that column keeps being written by the existing
 * debounced-autosave path, unmodified, so this route's only job is to keep
 * the CRDT log current for other collaborators. After appending, a
 * pointer-only NOTIFY tells other connected clients to fetch it (and
 * anything after it) from `GET /api/pages/[id]/yjs-updates` -- the raw
 * bytes never go through Postgres NOTIFY, which caps payloads at 8KB.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canEditPage, getPageAccess } from '@/lib/page-access';
import { isYjsCollabEnabled } from '@/lib/stream-config';
import { notifyYjsUpdate } from '@/lib/page-pubsub';

export const dynamic = 'force-dynamic';

// A single Yjs update for a realistic editing session (a few keystrokes to a
// paste) is well under this; it exists to reject a runaway/misbehaving
// client rather than to bound a legitimate update.
const MAX_UPDATE_BYTES = 2 * 1024 * 1024;

const PostBody = z.object({
  // Base64-encoded Yjs update bytes (Y.encodeStateAsUpdate / doc update
  // event payload). Kept as a string at the HTTP boundary since JSON has no
  // binary type.
  update: z.string().min(1),
  /**
   * True only for the one-time "convert this page's existing HTML into an
   * initial Yjs document" step a client performs the first time it opens a
   * page with no prior collaborative session (no snapshot, no update log).
   *
   * Two clients can race to seed the same page at once. Rather than append
   * to the log like a normal update, a seed is written via
   * `PageYjsSnapshot.create()`, guarded by that table's `@unique(pageId)`
   * constraint -- exactly one seed can ever win. The loser gets `{ seeded:
   * false }` back and must fetch the winner's snapshot instead of writing
   * its own version of the same content, or the two would coexist as
   * separately-inserted (and therefore visibly duplicated) content once
   * Yjs merges them -- Yjs's CRDT merge dedupes concurrent edits to the
   * *same* insertion, not two independent seeds that happen to render the
   * same starting text.
   */
  seed: z.boolean().optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: RouteContext) {
  if (!isYjsCollabEnabled()) {
    return NextResponse.json({ error: 'Collaborative editing is not enabled' }, { status: 501 });
  }

  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: pageId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = PostBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

  const access = await getPageAccess(pageId, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  if (!canEditPage(access.role)) {
    return NextResponse.json({ error: 'You cannot edit this page' }, { status: 403 });
  }

  let data: Buffer;
  try {
    data = Buffer.from(parsed.data.update, 'base64');
  } catch {
    return NextResponse.json({ error: 'Invalid update encoding' }, { status: 400 });
  }
  if (data.length === 0 || data.length > MAX_UPDATE_BYTES) {
    return NextResponse.json({ error: 'Update size out of range' }, { status: 400 });
  }

  if (parsed.data.seed) {
    try {
      await prisma.pageYjsSnapshot.create({
        data: { pageId, state: new Uint8Array(data) },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Someone else's seed landed first -- not an error, just a race
        // the caller needs to know it lost.
        return NextResponse.json({ seeded: false });
      }
      throw err;
    }
    // No NOTIFY here: a client that just discovered "no session exists yet"
    // is, by definition, the only client on the page so far (any other
    // concurrent opener would have raced this same seed step, not learned
    // about it via NOTIFY afterward).
    return NextResponse.json({ seeded: true }, { status: 201 });
  }

  const record = await prisma.pageYjsUpdate.create({
    // Prisma 7's Bytes fields are typed as Uint8Array<ArrayBuffer>, which a
    // Node Buffer doesn't structurally satisfy (its backing buffer is typed
    // as the wider ArrayBufferLike) -- copy into a plain Uint8Array.
    data: { pageId, data: new Uint8Array(data) },
    select: { id: true },
  });

  await notifyYjsUpdate(pageId, { pageId, updateId: record.id });

  return NextResponse.json({ id: record.id }, { status: 201 });
}
