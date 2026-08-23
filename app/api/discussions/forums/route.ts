import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { DISCUSSION_LABELS, DISCUSSION_LABEL_SLUGS } from '@/lib/discussion-labels';

export const dynamic = 'force-dynamic';

/**
 * GET /api/discussions/forums
 *
 * The discussion board is now a SINGLE general community forum (per-subject
 * forums were removed). This endpoint returns one virtual "General" forum
 * object with aggregated counts so the UI has a stable shape. It also returns
 * the canonical list of predefined labels (see lib/discussion-labels.ts) plus
 * any legacy free-text categories still present in the DB so the UI can render
 * a filter cloud that covers both.
 *
 * Signed-in only. The board is for the school community, and the counts and
 * legacy category names here describe what is being discussed, so they are not
 * public either.
 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const [threadCount, postCount, lastActivity, usedCategories] = await Promise.all([
      prisma.discussionThread.count(),
      prisma.discussionPost.count(),
      prisma.discussionThread.findFirst({
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      }),
      prisma.discussionThread.findMany({
        where: { category: { not: null } },
        select: { category: true },
        distinct: ['category'],
      }),
    ]);

    // Legacy free-text categories that aren't part of the predefined taxonomy.
    const legacyCategories = usedCategories
      .map((c) => c.category)
      .filter((c): c is string => c != null && !DISCUSSION_LABEL_SLUGS.includes(c))
      .sort();

    return NextResponse.json({
      forums: [
        {
          id: 0,
          code: 'general',
          name: 'General Discussion',
          threadCount,
          postCount: postCount + threadCount, // posts + OPs
          lastActivity: lastActivity?.updatedAt.toISOString() ?? null,
        },
      ],
      // Canonical predefined labels — drives the filter pills + create dialog.
      labels: DISCUSSION_LABELS,
      // Legacy categories preserved so existing threads stay filterable.
      categories: legacyCategories,
    });
  } catch (error) {
    console.error('Failed to list forums:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list forums' },
      { status: 500 }
    );
  }
}
