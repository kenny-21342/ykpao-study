import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health — liveness/readiness probe.
 *
 * Deliberately unauthenticated (uptime monitors can't sign in) but it reports
 * only booleans and a latency number: no version strings, no connection
 * details, nothing that helps someone fingerprint the deployment.
 *
 * Returns 503 when the database is unreachable so a platform health check can
 * actually fail rather than reporting a green light on a broken deploy.
 */
export async function GET() {
  const startedAt = Date.now();
  let databaseOk = false;

  try {
    // Cheapest possible round-trip that still proves the pool can reach
    // Postgres and run a statement.
    await prisma.$queryRaw`SELECT 1`;
    databaseOk = true;
  } catch (error) {
    console.error('[health] database check failed:', error);
  }

  const body = {
    status: databaseOk ? ('ok' as const) : ('degraded' as const),
    database: databaseOk,
    latencyMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(body, {
    status: databaseOk ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
