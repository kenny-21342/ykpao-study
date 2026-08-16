import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSyncUser } from '@/lib/sync-auth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/sync/bridge
 *
 * One-shot bridge that links the web's existing Note table to the new
 * CloudDocument sync layer. Called by:
 *   - the user clicking "Enable cloud sync" in account settings, OR
 *   - the iPad app on first login (to seed its library from existing notes).
 *
 * For every Note the user owns that does NOT yet have a corresponding
 * CloudDocument, this endpoint creates one with:
 *   - clientId = "web-" + note.id   (stable, recognisable)
 *   - body     = note.content         (already HTML/markdown-ish)
 *   - format   = "markdown"
 *
 * Idempotent: re-running only creates missing docs, never overwrites.
 */
export async function POST(req: NextRequest) {
  const user = await getSyncUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // All notes owned by the user.
  const notes = await prisma.note.findMany({
    where: { userId: user.id },
    select: { id: true, title: true, content: true, updatedAt: true },
    orderBy: { updatedAt: 'asc' },
  });

  // Existing cloud docs (so we only create missing ones).
  const existingDocs = await prisma.cloudDocument.findMany({
    where: { ownerId: user.id },
    select: { clientId: true },
  });
  const have = new Set(existingDocs.map((d) => d.clientId));

  let created = 0;
  for (const note of notes) {
    const clientId = `web-${note.id}`;
    if (have.has(clientId)) continue;

    await prisma.cloudDocument.create({
      data: {
        ownerId: user.id,
        clientId,
        title: note.title || 'Untitled',
        format: 'markdown',
        body: note.content || '',
        blocks: Prisma.JsonNull,
      },
    });
    created++;
  }

  return NextResponse.json({ ok: true, created, total: notes.length });
}
