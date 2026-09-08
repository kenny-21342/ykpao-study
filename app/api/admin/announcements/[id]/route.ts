import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { indexAnnouncement, refreshRagIndex } from '@/lib/rag-index';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/announcements/[id]
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  const announcement = await prisma.announcement.findUnique({
    where: { id },
    include: { author: { select: { name: true, email: true } } },
  });
  if (!announcement) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ announcement });
}

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).optional(),
  severity: z.enum(['info', 'success', 'warning', 'critical']).optional(),
  audience: z.enum(['all', 'students', 'teachers']).optional(),
  pinned: z.boolean().optional(),
  published: z.boolean().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

/**
 * PATCH /api/admin/announcements/[id]
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.issues }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  const d = parsed.data;
  if (d.title !== undefined) data.title = d.title;
  if (d.body !== undefined) data.body = d.body;
  if (d.severity !== undefined) data.severity = d.severity;
  if (d.audience !== undefined) data.audience = d.audience;
  if (d.pinned !== undefined) data.pinned = d.pinned;
  if (d.published !== undefined) data.published = d.published;
  if (d.expiresAt !== undefined) data.expiresAt = d.expiresAt ? new Date(d.expiresAt) : null;

  const updated = await prisma.announcement.update({ where: { id }, data });
  await refreshRagIndex(`announcement:${id}`, () => indexAnnouncement(id));
  return NextResponse.json({ announcement: updated });
}

/**
 * DELETE /api/admin/announcements/[id]
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  await prisma.announcement.delete({ where: { id } });
  await refreshRagIndex(`announcement:${id}`, () => indexAnnouncement(id));
  return NextResponse.json({ success: true });
}
