import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { createNotifications } from '@/lib/notifications';
import { indexNote, refreshRagIndex } from '@/lib/rag-index';

export const dynamic = 'force-dynamic';

/**
 * Access helper: returns the note if the user is the owner OR a collaborator.
 * Returns null if not found / no access.
 */
async function getAccessibleNote(noteId: string, userId: string) {
  const note = await prisma.note.findUnique({
    where: { id: noteId },
    select: {
      id: true,
      userId: true,
      title: true,
      collaborators: { include: { user: { select: { id: true, name: true, image: true, email: true } } } },
    },
  });
  if (!note) return null;
  const isOwner = note.userId === userId;
  const collab = note.collaborators.find((c) => c.userId === userId);
  if (!isOwner && !collab) return null;
  return { note, isOwner, role: isOwner ? 'owner' : collab?.role ?? 'viewer' };
}

/**
 * GET /api/notes/[id]/collaborators
 *   List collaborators on a note. Owner + collaborators can view.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const accessible = await getAccessibleNote(id, user.id);
  if (!accessible) return NextResponse.json({ error: 'Note not found' }, { status: 404 });

  // Owner info + collaborator rows.
  const owner = await prisma.user.findUnique({
    where: { id: accessible.note.userId },
    select: { id: true, name: true, email: true, image: true },
  });

  return NextResponse.json({
    owner,
    role: accessible.role,
    collaborators: accessible.note.collaborators.map((c) => ({
      id: c.id,
      role: c.role,
      createdAt: c.createdAt,
      user: c.user,
    })),
  });
}

const AddBody = z.object({
  email: z.string().email(),
  role: z.enum(['editor', 'viewer']).default('editor'),
});

/**
 * POST /api/notes/[id]/collaborators
 *   { email, role } — invite a collaborator by email. Owner only.
 *   Idempotent: if already a collaborator, updates the role.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const accessible = await getAccessibleNote(id, user.id);
  if (!accessible) return NextResponse.json({ error: 'Note not found' }, { status: 404 });
  if (!accessible.isOwner) {
    return NextResponse.json({ error: 'Only the owner can invite collaborators' }, { status: 403 });
  }

  let parsed;
  try {
    parsed = AddBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request' },
      { status: 400 }
    );
  }

  const invitee = await prisma.user.findUnique({
    where: { email: parsed.email.toLowerCase() },
    select: { id: true, name: true, email: true },
  });
  if (!invitee) {
    return NextResponse.json({ error: 'No user found with that email' }, { status: 404 });
  }
  if (invitee.id === user.id) {
    return NextResponse.json({ error: 'You already own this note' }, { status: 400 });
  }

  // Upsert collaborator row.
  const collab = await prisma.noteCollaborator.upsert({
    where: { noteId_userId: { noteId: id, userId: invitee.id } },
    create: { noteId: id, userId: invitee.id, role: parsed.role },
    update: { role: parsed.role },
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
  });

  // Notify the invitee.
  await createNotifications([
    {
      userId: invitee.id,
      actorId: user.id,
      type: 'note_invite',
      entityId: id,
      entityUrl: `/notes/${id}`,
      title: `${user.name ?? 'Someone'} invited you to collaborate on "${accessible.note.title}"`,
      body: `Role: ${parsed.role}`,
    },
  ]);
  await refreshRagIndex(`note:${id}`, () => indexNote(id));

  return NextResponse.json({ ok: true, collaborator: collab }, { status: 201 });
}

const RemoveBody = z.object({ userId: z.string() });

/**
 * DELETE /api/notes/[id]/collaborators
 *   { userId } — remove a collaborator. Owner only, or a collaborator removing themselves.
 *   Query: ?userId=xxx also supported.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const accessible = await getAccessibleNote(id, user.id);
  if (!accessible) return NextResponse.json({ error: 'Note not found' }, { status: 404 });

  // Resolve target userId from body or query.
  let targetUserId: string | undefined;
  const url = new URL(req.url);
  targetUserId = url.searchParams.get('userId') ?? undefined;
  if (!targetUserId) {
    try {
      const body = await req.json();
      targetUserId = RemoveBody.parse(body).userId;
    } catch {
      // ignore
    }
  }
  if (!targetUserId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  }

  // A collaborator can remove themselves; otherwise only owner can remove.
  if (targetUserId !== user.id && !accessible.isOwner) {
    return NextResponse.json({ error: 'Only the owner can remove other collaborators' }, { status: 403 });
  }

  await prisma.noteCollaborator.deleteMany({
    where: { noteId: id, userId: targetUserId },
  });
  await refreshRagIndex(`note:${id}`, () => indexNote(id));

  return NextResponse.json({ ok: true });
}
