import { prisma } from '@/lib/prisma';

/**
 * Durable fixed-window rate limiter, backed by Postgres.
 *
 * WHY NOT IN-MEMORY: the previous implementation was a per-process `Map`.
 * That is fine for one long-lived server, but the deploy target is Vercel,
 * where each serverless invocation may get a fresh process — so every request
 * saw an empty map and no limit was ever reached. The login brute-force guard
 * and the per-user AI spend caps both silently did nothing.
 *
 * WHY POSTGRES AND NOT REDIS: the database is already a hard dependency and
 * already on the request path for every one of these routes, so this adds no
 * new service, no new failure mode, and no new credentials to rotate. The
 * cost is one extra round trip on rate-limited routes — all of which then go
 * on to do far more expensive work (bcrypt, or an LLM call).
 *
 * The counter update is a single atomic `INSERT … ON CONFLICT DO UPDATE`, so
 * concurrent requests across instances cannot lose increments the way a
 * read-then-write pair would.
 *
 * Usage:
 *   const rl = rateLimit({ intervalMs: 60_000, max: 20 });
 *   if (!(await rl.check(userId))) return 429;
 */

type LimiterOpts = {
  intervalMs: number;
  max: number;
  /**
   * What to do when the datastore itself is unreachable.
   *
   * Defaults to 'closed' (deny). These limiters guard password verification
   * and paid LLM calls; if the database is down those requests cannot succeed
   * anyway, so denying is both safer and no more disruptive.
   */
  onError?: 'open' | 'closed';
};

export type Limiter = {
  check(key: string): Promise<boolean>;
  remaining(key: string): Promise<number>;
};

/** Postgres `undefined_table`. Surfaced by Prisma as the raw driver code. */
const UNDEFINED_TABLE = '42P01';

function isUndefinedTable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  return (
    candidate.code === UNDEFINED_TABLE || candidate.meta?.code === UNDEFINED_TABLE
  );
}

/** Probability of sweeping expired rows on any given call. */
const SWEEP_PROBABILITY = 0.01;

async function sweepExpired(): Promise<void> {
  try {
    await prisma.rateLimit.deleteMany({ where: { resetAt: { lt: new Date() } } });
  } catch {
    // Housekeeping only — never let it affect the caller.
  }
}

export function rateLimit({ intervalMs, max, onError = 'closed' }: LimiterOpts): Limiter {
  return {
    async check(key: string): Promise<boolean> {
      const resetAt = new Date(Date.now() + intervalMs);

      try {
        // One statement, one round trip, atomic under concurrency:
        //  - no row, or the window has elapsed  -> start a new window at 1
        //  - window still open                  -> increment
        // The returned count is this request's position in the window, so the
        // request is allowed exactly when it is <= max.
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`
          INSERT INTO rate_limits ("key", "count", "resetAt")
          VALUES (${key}, 1, ${resetAt})
          ON CONFLICT ("key") DO UPDATE SET
            "count" = CASE
              WHEN rate_limits."resetAt" <= now() THEN 1
              ELSE rate_limits."count" + 1
            END,
            "resetAt" = CASE
              WHEN rate_limits."resetAt" <= now() THEN ${resetAt}
              ELSE rate_limits."resetAt"
            END
          RETURNING "count"
        `;

        if (Math.random() < SWEEP_PROBABILITY) void sweepExpired();

        const count = rows[0]?.count ?? 0;
        return count <= max;
      } catch (error) {
        // Deploying this code before running `prisma migrate deploy` leaves
        // the table missing. Failing closed on that would lock every user out
        // of the platform, which is far worse than the unenforced limits we
        // are replacing — so treat a missing table as a loud configuration
        // error and allow the request. Every other failure (connection lost,
        // timeout, permissions) still fails closed.
        if (isUndefinedTable(error)) {
          console.error(
            '[rate-limit] the rate_limits table does not exist — rate limiting is ' +
              'DISABLED. Run `prisma migrate deploy`. (key: %s)',
            key,
          );
          return true;
        }
        console.error('[rate-limit] backend unavailable for key %s:', key, error);
        return onError === 'open';
      }
    },

    async remaining(key: string): Promise<number> {
      try {
        const row = await prisma.rateLimit.findUnique({ where: { key } });
        if (!row || row.resetAt <= new Date()) return max;
        return Math.max(0, max - row.count);
      } catch {
        return 0;
      }
    },
  };
}

// Per-user, per-minute cap on AI endpoints. This is the spend control: every
// call behind it costs money.
export const aiLimiter = rateLimit({ intervalMs: 60_000, max: 20 });

// Password verification and account creation. Deliberately tight — five
// attempts per minute per IP (and, for login, per account).
export const strictLimiter = rateLimit({ intervalMs: 60_000, max: 5 });

/**
 * Record an AI usage event for the Usage & API Credits dashboard.
 * Never throws — usage logging is best-effort.
 */
export async function recordUsage(opts: {
  userId: string;
  feature: string;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  model?: string;
}) {
  try {
    await prisma.usageRecord.create({
      data: {
        userId: opts.userId,
        feature: opts.feature,
        tokensIn: opts.tokensIn ?? 0,
        tokensOut: opts.tokensOut ?? 0,
        cost: opts.cost ?? 0,
        model: opts.model ?? 'deepseek-chat',
      },
    });
  } catch (err) {
    // Best-effort; never let telemetry break the request — but log so a
    // misconfigured table or bad payload doesn't fail silently.
    console.error('[recordUsage] failed to log usage:', err);
  }
}
