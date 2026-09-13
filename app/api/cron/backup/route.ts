import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { runBackup } from '@/lib/backup';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

/**
 * Reads every table it backs up and gzips the result, so give it the whole
 * invocation rather than the default.
 */
export const maxDuration = 300;

/**
 * GET /api/cron/backup — write a snapshot to the object store.
 *
 * Vercel Cron calls this on the schedule in vercel.json, sending
 * `Authorization: Bearer $CRON_SECRET` automatically once that variable is set
 * on the project. An admin may also call it by hand, which is how you check a
 * backup works without waiting until 03:00.
 *
 * Without CRON_SECRET set the route refuses everything except an admin: an
 * unauthenticated endpoint that dumps the database is worse than no backup.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authorized =
    (Boolean(secret) && request.headers.get('authorization') === `Bearer ${secret}`) ||
    Boolean(await requireAdmin());

  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await runBackup();
    console.log(
      '[backup] wrote %s (%d bytes) in %dms, pruned %d',
      result.key,
      result.bytes,
      result.durationMs,
      result.prunedKeys,
    );
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    // A silent backup failure is the worst kind: everything looks fine until
    // the day it is needed. Route it through the error tracker.
    await reportError(error, {
      path: '/api/cron/backup',
      method: 'GET',
      routePath: '/api/cron/backup',
      source: 'backup',
    });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Backup failed' },
      { status: 500 },
    );
  }
}
