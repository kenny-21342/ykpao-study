import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/stats
 * Platform-wide aggregate metrics for the admin dashboard.
 */
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    totalUsers, newUsers7d, newUsers30d, bannedUsers,
    threads, posts, sharedNotes, schoolResources,
    mockExams, pastPaperAttempts, notebooks,
    announcements, activeAnnouncements,
    aiUsageAll, aiUsage30d,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
    prisma.user.count({ where: { banned: true } }),
    prisma.discussionThread.count(),
    prisma.discussionPost.count(),
    prisma.sharedNote.count(),
    prisma.schoolResource.count(),
    prisma.mockExam.count(),
    prisma.pastPaperAttempt.count(),
    prisma.notebook.count(),
    prisma.announcement.count(),
    prisma.announcement.count({ where: { published: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
    prisma.usageRecord.aggregate({ _sum: { cost: true, tokensIn: true, tokensOut: true }, _count: true }),
    prisma.usageRecord.aggregate({
      where: { createdAt: { gte: thirtyDaysAgo } },
      _sum: { cost: true, tokensIn: true, tokensOut: true },
      _count: true,
    }),
  ]);

  // Signups over the last 14 days (for chart).
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const recentUsers = await prisma.user.findMany({
    where: { createdAt: { gte: fourteenDaysAgo } },
    select: { createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const signupsByDay: Record<string, number> = {};
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    signupsByDay[d.toISOString().slice(5, 10)] = 0;
  }
  for (const u of recentUsers) {
    const key = u.createdAt.toISOString().slice(5, 10);
    if (key in signupsByDay) signupsByDay[key]++;
  }

  // AI usage by feature (last 30 days, top 8).
  const usageByFeatureRaw = await prisma.usageRecord.groupBy({
    by: ['feature'],
    where: { createdAt: { gte: thirtyDaysAgo } },
    _sum: { cost: true },
    _count: true,
    orderBy: { _count: { feature: 'desc' } },
    take: 8,
  });

  // Role distribution.
  const roleDistribution = await prisma.user.groupBy({
    by: ['role'],
    _count: true,
  });

  return NextResponse.json({
    users: { total: totalUsers, new7d: newUsers7d, new30d: newUsers30d, banned: bannedUsers },
    content: { threads, posts, sharedNotes, schoolResources, mockExams, pastPaperAttempts, notebooks },
    announcements: { total: announcements, active: activeAnnouncements },
    ai: {
      totalCost: aiUsageAll._sum.cost ?? 0,
      totalRequests: aiUsageAll._count,
      totalTokensIn: aiUsageAll._sum.tokensIn ?? 0,
      totalTokensOut: aiUsageAll._sum.tokensOut ?? 0,
      cost30d: aiUsage30d._sum.cost ?? 0,
      requests30d: aiUsage30d._count,
    },
    charts: {
      signupsByDay: Object.entries(signupsByDay).map(([date, count]) => ({ date, count })),
      usageByFeature: usageByFeatureRaw.map((r) => ({ feature: r.feature, cost: r._sum.cost ?? 0, requests: r._count })),
      roleDistribution: roleDistribution.map((r) => ({ role: r.role, count: r._count })),
    },
  });
  } catch (err) {
    console.error('[admin/stats] error:', err);
    await reportError(err, { routePath: '/api/admin/stats', source: 'route' });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    );
  }
}
