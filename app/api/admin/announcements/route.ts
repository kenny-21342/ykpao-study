import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { indexAnnouncement, refreshRagIndex } from '@/lib/rag-index';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/announcements
 * List all announcements (including drafts / expired), newest first.
 */
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const announcements = await prisma.announcement.findMany({
    include: { author: { select: { name: true, email: true, image: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ announcements });
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  severity: z.enum(['info', 'success', 'warning', 'critical']).default('info'),
  audience: z.enum(['all', 'students', 'teachers']).default('all'),
  pinned: z.boolean().default(false),
  published: z.boolean().default(true),
  expiresAt: z.string().datetime().nullable().optional(),
});

/**
 * POST /api/admin/announcements
 * Create a new announcement and (if published) broadcast a notification to all users.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;

  const announcement = await prisma.announcement.create({
    data: {
      authorId: admin.id,
      title: d.title,
      body: d.body,
      severity: d.severity,
      audience: d.audience,
      pinned: d.pinned,
      published: d.published,
      expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
    },
  });

  await refreshRagIndex(`announcement:${announcement.id}`, () => indexAnnouncement(announcement.id));

  // Broadcast in-app notifications to all matching users if published.
  if (d.published) {
    const where: Record<string, unknown> = {};
    if (d.audience === 'students') where.role = 'student';
    else if (d.audience === 'teachers') where.role = 'teacher';
    const recipients = await prisma.user.findMany({
      where,
      select: { id: true },
    });
    if (recipients.length > 0) {
      await prisma.notification.createMany({
        data: recipients.map((r) => ({
          userId: r.id,
          actorId: admin.id,
          type: 'announcement',
          entityId: announcement.id,
          entityUrl: '/announcements',
          title: d.title,
          body: d.body.length > 200 ? d.body.slice(0, 200) + '…' : d.body,
        })),
      });
    }
  }

  return NextResponse.json({ announcement });
}
