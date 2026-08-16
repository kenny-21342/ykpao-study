import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// GET /api/usage — usage stats for the authenticated user
export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Total usage
    const records = await prisma.usageRecord.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });

    const totals = records.reduce(
      (acc, r) => {
        acc.totalTokensIn += r.tokensIn;
        acc.totalTokensOut += r.tokensOut;
        acc.totalCost += r.cost;
        return acc;
      },
      { totalTokensIn: 0, totalTokensOut: 0, totalCost: 0 }
    );

    // Breakdown by feature
    const byFeature: Record<string, { count: number; tokens: number; cost: number }> = {};
    for (const r of records) {
      const key = r.feature;
      if (!byFeature[key]) byFeature[key] = { count: 0, tokens: 0, cost: 0 };
      byFeature[key].count++;
      byFeature[key].tokens += r.tokensIn + r.tokensOut;
      byFeature[key].cost += r.cost;
    }

    // Last 7 days daily breakdown
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recent = records.filter((r) => r.createdAt >= sevenDaysAgo);
    const byDay: Record<string, { tokens: number; cost: number; count: number }> = {};
    for (const r of recent) {
      const day = r.createdAt.toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = { tokens: 0, cost: 0, count: 0 };
      byDay[day].tokens += r.tokensIn + r.tokensOut;
      byDay[day].cost += r.cost;
      byDay[day].count++;
    }

    return NextResponse.json({
      totals: {
        ...totals,
        totalRequests: records.length,
        totalCost: Number(totals.totalCost.toFixed(4)),
      },
      byFeature,
      byDay,
      recent: recent.slice(0, 50).map((r) => ({
        id: r.id,
        feature: r.feature,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        cost: r.cost,
        model: r.model,
        createdAt: r.createdAt,
      })),
    });
  } catch (error) {
    console.error('Failed to fetch usage:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch usage' },
      { status: 500 }
    );
  }
}
