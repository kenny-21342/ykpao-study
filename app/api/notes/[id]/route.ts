import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { indexNote, refreshRagIndex } from '@/lib/rag-index';

export const dynamic = 'force-dynamic';

/**
 * Access helper: returns the note plus access metadata if the user is the
 * owner OR a collaborator (any role). Returns null otherwise.
 */
async function getAccessibleNote(noteId: string, userId: string) {
  const note = await prisma.note.findUnique({
    where: { id: noteId },
    include: {
      folder: true,
      collaborators: { select: { userId: true, role: true } },
    },
  });
  if (!note) return null;
  const isOwner = note.userId === userId;
  const collab = note.collaborators.find((c) => c.userId === userId);
  if (!isOwner && !collab) return null;
  return {
    note,
    isOwner,
    role: isOwner ? 'owner' : (collab?.role ?? 'viewer'),
  };
}

// GET /api/notes/[id] — fetch a note (owner or collaborator).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const accessible = await getAccessibleNote(id, user.id);
    if (!accessible) return NextResponse.json({ error: 'Note not found' }, { status: 404 });

    return NextResponse.json({ ...accessible.note, _role: accessible.role });
  } catch (error) {
    console.error('Failed to fetch note:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch note' },
      { status: 500 }
    );
  }
}

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(500_000).optional(),
  tags: z.array(z.string()).optional(),
  folderId: z.string().nullable().optional(),
});

// PATCH /api/notes/[id] — update a note. Owner or editor collaborators.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const accessible = await getAccessibleNote(id, user.id);
    if (!accessible) return NextResponse.json({ error: 'Note not found' }, { status: 404 });
    // Viewers cannot edit.
    if (accessible.role === 'viewer') {
      return NextResponse.json({ error: 'You only have view access' }, { status: 403 });
    }

    let parsed;
    try {
      parsed = PatchBody.parse(await req.json());
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Invalid request' },
        { status: 400 }
      );
    }

    // Only pick defined fields so unspecified fields are not nulled out.
    const data: Record<string, unknown> = {};
    if (parsed.title !== undefined) data.title = parsed.title.trim();
    if (parsed.content !== undefined) data.content = parsed.content;
    if (parsed.tags !== undefined) data.tags = parsed.tags.filter(Boolean);
    if (parsed.folderId !== undefined) data.folderId = parsed.folderId;

    const updated = await prisma.note.update({
      where: { id },
      data,
    });
    await refreshRagIndex(`note:${id}`, () => indexNote(id));

    return NextResponse.json(updated);
  } catch (error) {
    console.error('Failed to update note:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update note' },
      { status: 500 }
    );
  }
}

// DELETE /api/notes/[id] — delete a note. Owner only.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { id } = await params;

    // Strict ownership check — collaborators cannot delete the note.
    const existing = await prisma.note.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Note not found' }, { status: 404 });
    }

    await prisma.note.delete({ where: { id } });
    await refreshRagIndex(`note:${id}`, () => indexNote(id));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete note:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete note' },
      { status: 500 }
    );
  }
}
