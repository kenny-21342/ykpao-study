import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/system
 * System health: AI usage breakdown, error tracking, storage estimates, table counts.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    usageByModel,
    usageByFeature,
    errors24h,
    requests24h,
    totalCost,
    cost7d,
    topUsersByCost,
    tableCounts,
    errorGroups,
    latestErrors,
  ] = await Promise.all([
    prisma.usageRecord.groupBy({
      by: ['model'],
      _sum: { cost: true, tokensIn: true, tokensOut: true },
      _count: true,
      orderBy: { _count: { model: 'desc' } },
    }),
    prisma.usageRecord.groupBy({
      by: ['feature'],
      _sum: { cost: true },
      _count: true,
      orderBy: { _count: { feature: 'desc' } },
    }),
    prisma.errorEvent.count({ where: { createdAt: { gte: twentyFourHoursAgo } } }),
    prisma.usageRecord.count({ where: { createdAt: { gte: twentyFourHoursAgo } } }),
    prisma.usageRecord.aggregate({ _sum: { cost: true } }),
    prisma.usageRecord.aggregate({ where: { createdAt: { gte: sevenDaysAgo } }, _sum: { cost: true } }),
    prisma.usageRecord.groupBy({
      by: ['userId'],
      _sum: { cost: true },
      _count: { _all: true },
      orderBy: { _sum: { cost: 'desc' } },
      take: 10,
    }),
    Promise.all([
      { name: 'users', count: prisma.user.count() },
      { name: 'notes', count: prisma.note.count() },
      { name: 'sharedNotes', count: prisma.sharedNote.count() },
      { name: 'discussionThreads', count: prisma.discussionThread.count() },
      { name: 'discussionPosts', count: prisma.discussionPost.count() },
      { name: 'mockExams', count: prisma.mockExam.count() },
      { name: 'schoolResources', count: prisma.schoolResource.count() },
      { name: 'pastPaperAttempts', count: prisma.pastPaperAttempt.count() },
    ].map(async (t) => ({ name: t.name, count: await t.count }))),
    // Grouped so one repeating bug reads as one row, not two hundred.
    prisma.errorEvent.groupBy({
      by: ['fingerprint'],
      where: { createdAt: { gte: sevenDaysAgo } },
      _count: true,
      _max: { createdAt: true },
      orderBy: { _count: { fingerprint: 'desc' } },
      take: 20,
    }),
    prisma.errorEvent.findMany({
      where: { createdAt: { gte: sevenDaysAgo } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        fingerprint: true, message: true, path: true, method: true,
        routePath: true, source: true, createdAt: true,
      },
    }),
  ]);

  // Resolve top users' emails.
  const topUserIds = topUsersByCost.map((u) => u.userId);
  const topUserRows = await prisma.user.findMany({
    where: { id: { in: topUserIds } },
    select: { id: true, email: true, name: true },
  });
  const topUsers = topUsersByCost.map((u) => {
    const row = topUserRows.find((r) => r.id === u.userId);
    return { email: row?.email ?? 'unknown', name: row?.name, cost: u._sum.cost ?? 0, requests: u._count._all };
  });

  // Storage estimate from school-resource file sizes, plus the handful of
  // files actually worth looking at when the total looks wrong.
  const [resourceBytes, largestFiles] = await Promise.all([
    prisma.schoolResource.aggregate({ _sum: { fileSize: true } }),
    prisma.schoolResource.findMany({
      orderBy: { fileSize: 'desc' },
      take: 10,
      select: { title: true, fileName: true, fileSize: true },
    }),
  ]);
  const totalStorageBytes = (resourceBytes._sum.fileSize ?? 0);

  return NextResponse.json({
    ai: {
      byModel: usageByModel.map((m) => ({
        model: m.model,
        cost: m._sum.cost ?? 0,
        tokensIn: m._sum.tokensIn ?? 0,
        tokensOut: m._sum.tokensOut ?? 0,
        requests: m._count,
      })),
      byFeature: usageByFeature.map((f) => ({ feature: f.feature, cost: f._sum.cost ?? 0, requests: f._count })),
      errors24h,
      requests24h,
      totalCost: totalCost._sum.cost ?? 0,
      cost7d: cost7d._sum.cost ?? 0,
      topUsers,
    },
    storage: {
      totalBytes: totalStorageBytes,
      totalMB: Math.round((totalStorageBytes / (1024 * 1024)) * 100) / 100,
      largestFiles,
    },
    tables: tableCounts,
    errors: {
      last24h: errors24h,
      // One entry per distinct bug in the last 7 days, most frequent first.
      groups: errorGroups.map((g) => ({
        fingerprint: g.fingerprint,
        count: g._count,
        lastSeen: g._max.createdAt,
        message: latestErrors.find((e) => e.fingerprint === g.fingerprint)?.message ?? null,
      })),
      recent: latestErrors,
    },
  });
}
