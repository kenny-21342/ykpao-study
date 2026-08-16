import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * GET /api/announcements
 *   ?all=true  → show ALL published announcements (for the announcements page)
 *   default    → show only the 10 most recent (for the dashboard banner)
 *
 * No auth required — announcements are public.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const showAll = searchParams.get('all') === 'true';
  const now = new Date();

  const announcements = await prisma.announcement.findMany({
    where: {
      published: true,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: now } },
      ],
    },
    orderBy: [
      { pinned: 'desc' },
      { createdAt: 'desc' },
    ],
    select: {
      id: true,
      title: true,
      body: true,
      pinned: true,
      createdAt: true,
      author: { select: { name: true } },
    },
    ...(showAll ? {} : { take: 10 }),
  });

  return NextResponse.json({ announcements });
}
