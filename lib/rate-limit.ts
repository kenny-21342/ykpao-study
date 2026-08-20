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

// "Test my key": one outbound request to a user-supplied https endpoint per
// press. Tighter than the AI limiter because it is a user-directed fetch and
// therefore an SSRF-amplification and free-proxy surface, and because nobody
// needs to check the same key twenty times a minute.
export const keyTestLimiter = rateLimit({ intervalMs: 60_000, max: 5 });

// Password verification and account creation. Deliberately tight — five
// attempts per minute per IP (and, for login, per account).
export const strictLimiter = rateLimit({ intervalMs: 60_000, max: 5 });

type AiAllowance =
  | { allowed: true }
  | { allowed: false; reason: 'rate' | 'budget' | 'unavailable'; message: string };

type AiAllowanceOptions = {
  /** Number of paid provider calls this request can fan out into. */
  requests?: number;
  /**
   * Whose key pays for the call.
   *
   * 'shared' — the owner's server key, reached only by an admin-granted
   * account. Still the owner's money, so the monthly dollar cap still applies.
   *
   * 'user' — the student's own bring-your-own key. Their provider bills them
   * directly and enforces its own limits, so the owner's dollar cap is not
   * theirs to spend. The per-minute limiter still applies: it protects this
   * platform's function budget and database, not the owner's wallet.
   */
  source?: 'user' | 'shared';
};

const MICRO_USD_PER_USD = 1_000_000;

function positiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Hard per-user monthly ceiling, expressed in USD.
 *
 * The reservation is intentionally conservative: reserve before calling the
 * provider and never refund the difference. That makes the ceiling safe under
 * concurrent serverless requests, whereas summing UsageRecord rows after the
 * provider responds can always overshoot.
 */
const AI_MONTHLY_USER_SPEND_LIMIT_USD = positiveNumber(
  process.env.AI_MONTHLY_USER_SPEND_LIMIT_USD,
  5,
);
const AI_REQUEST_RESERVE_USD = positiveNumber(
  process.env.AI_REQUEST_RESERVE_USD,
  0.02,
);

function startOfNextUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

async function reserveMonthlyAiSpend(
  userId: string,
  requests: number,
): Promise<'allowed' | 'budget' | 'unavailable'> {
  const now = new Date();
  const safeRequests = Math.max(1, Math.min(100, Math.ceil(requests)));
  const reserveMicroUsd = Math.max(
    1,
    Math.ceil(AI_REQUEST_RESERVE_USD * safeRequests * MICRO_USD_PER_USD),
  );
  const capMicroUsd = Math.max(
    1,
    Math.floor(AI_MONTHLY_USER_SPEND_LIMIT_USD * MICRO_USD_PER_USD),
  );
  if (reserveMicroUsd > capMicroUsd) return 'budget';

  const resetAt = startOfNextUtcMonth(now);
  const month = now.toISOString().slice(0, 7);
  const key = `ai-spend:${month}:${userId}`;

  try {
    // The WHERE clause is the hard-cap guarantee: when an open window lacks
    // enough budget, Postgres performs no update and RETURNING yields no row.
    // Competing invocations serialize on this key, so they cannot both reserve
    // the same remaining allowance.
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      INSERT INTO rate_limits ("key", "count", "resetAt")
      VALUES (${key}, ${reserveMicroUsd}, ${resetAt})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN rate_limits."resetAt" <= now() THEN EXCLUDED."count"
          ELSE rate_limits."count" + EXCLUDED."count"
        END,
        "resetAt" = CASE
          WHEN rate_limits."resetAt" <= now() THEN EXCLUDED."resetAt"
          ELSE rate_limits."resetAt"
        END
      WHERE rate_limits."resetAt" <= now()
         OR rate_limits."count" + EXCLUDED."count" <= ${capMicroUsd}
      RETURNING "count"
    `;
    return rows.length === 1 ? 'allowed' : 'budget';
  } catch (error) {
    console.error('[ai-spend-limit] failed to reserve budget for user %s:', userId, error);
    // Paid operations fail closed when their durable spend control cannot be
    // verified. A database outage prevents the surrounding route from doing
    // useful work anyway, and allowing the provider call would remove the cap.
    return 'unavailable';
  }
}

/**
 * Check both AI controls before a paid provider call.
 *
 * The per-minute key is deliberately feature-agnostic. Previously callers
 * used keys such as `mock-exam-generate:<id>` and `practice-grade:<id>`, which
 * multiplied one student's allowance by the number of endpoints they used.
 */
export async function checkAiAllowance(
  userId: string,
  options: AiAllowanceOptions = {},
): Promise<AiAllowance> {
  if (!(await aiLimiter.check(`ai-minute:${userId}`))) {
    return {
      allowed: false,
      reason: 'rate',
      message: 'Too many AI requests. Please wait a minute and try again.',
    };
  }

  // A user's own key never touches the owner's monthly budget.
  if (options.source === 'user') return { allowed: true };

  const monthly = await reserveMonthlyAiSpend(userId, options.requests ?? 1);
  if (monthly === 'budget') {
    return {
      allowed: false,
      reason: 'budget',
      message: `Your monthly AI allowance has been reached. It resets on ${startOfNextUtcMonth().toISOString().slice(0, 10)}.`,
    };
  }
  if (monthly === 'unavailable') {
    return {
      allowed: false,
      reason: 'unavailable',
      message: 'AI is temporarily unavailable because usage controls could not be verified. Please try again.',
    };
  }
  return { allowed: true };
}

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
