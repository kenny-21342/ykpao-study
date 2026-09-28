import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health — liveness by default, readiness on request.
 *
 * Deliberately unauthenticated (uptime monitors cannot sign in) but it reports
 * only booleans and a latency number: no version strings, no connection
 * details, nothing that helps someone fingerprint the deployment.
 *
 * **The default no longer touches the database, and that is a cost decision
 * rather than a tidying one.** This route ran `SELECT 1` on every request, and
 * it is the most requested path on the site: 90 hits in 42 minutes on
 * 28 Sep 2026, one every 28 seconds, ahead of the home page. Against a server
 * that is always on, that is free. Against a compute that suspends after five
 * minutes of inactivity it is the most expensive line in the codebase -- a
 * database round-trip every 28 seconds means the compute never once reaches
 * idle, which is roughly 180 CU-hours a month spent staying awake before a
 * single student signs in, and it cancels every other saving.
 *
 * Liveness and readiness are different questions and only one of them belongs
 * on a 30-second timer. "Is the app serving?" can be answered without the
 * database. "Can the app reach its database?" is asked with `?deep=1` -- by a
 * deploy check, by the runbook, by a human who suspects an outage.
 *
 * What is given up: a monitor polling the default path will not, by itself,
 * notice a database outage. That is an acceptable trade because a database
 * outage is not subtle -- every real request fails, and Vercel's runtime logs
 * carry the exception. Note that `error_events` does *not*, when the cause is
 * connection exhaustion: writing that row needs the connection that ran out,
 * so the table is emptiest exactly when the problem is worst. Runtime logs are
 * the source of truth for this failure, not the error table.
 */
export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const deep = new URL(req.url).searchParams.get('deep') === '1';

  if (!deep) {
    return NextResponse.json(
      {
        status: 'ok' as const,
        // Explicitly null rather than `true`: saying "the database is fine"
        // without having asked is worse than saying nothing.
        database: null,
        checked: 'liveness' as const,
        latencyMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  let databaseOk = false;
  try {
    // Cheapest possible round-trip that still proves the pool can reach
    // Postgres and run a statement.
    await prisma.$queryRaw`SELECT 1`;
    databaseOk = true;
  } catch (error) {
    console.error('[health] database check failed:', error);
  }

  return NextResponse.json(
    {
      status: databaseOk ? ('ok' as const) : ('degraded' as const),
      database: databaseOk,
      checked: 'readiness' as const,
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    },
    {
      status: databaseOk ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
