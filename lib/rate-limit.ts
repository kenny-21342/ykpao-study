import { prisma } from '@/lib/prisma';
import { estimateCostUsd } from './ai-pricing.ts';
import { isMonthlyCapDisabled } from './spend-cap.ts';
import { sharedModelIsFree } from './ai-credentials.ts';

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

// Password verification and account creation, keyed to **one account**.
//
// This is the control that matters: it is what stops an attacker converging on
// a single student's password, and it is unaffected by how many other people
// are online. Keep it tight.
export const strictLimiter = rateLimit({ intervalMs: 60_000, max: 5 });

/**
 * The same endpoints, keyed to the client **IP**, and deliberately far looser.
 *
 * A school year group reaches the internet through one NAT, so every student
 * on the school network shares an `x-forwarded-for` address. At five per
 * minute per IP, a class of thirty signing in at the start of a lesson locks
 * itself out after the fifth of them — and the message tells each student to
 * wait a minute, which does not help, because their classmates keep spending
 * the budget as fast as it refills. The same arithmetic breaks a whole form
 * registering in one period.
 *
 * So the per-IP limiter is sized for a cohort behind one address, and the
 * per-account limiter above is left to do the security work. The trade-off is
 * real and worth stating plainly: one host can now try more distinct accounts
 * per hour than it could before. It still cannot make progress against any
 * *particular* account, which is what password spraying is for, and the
 * alternative — a limit that a normal lesson trips — is not a defence, because
 * it fails the people it is supposed to protect first and hardest.
 *
 * Windows are longer than a minute on purpose: a burst at the start of a
 * lesson is the expected shape of the traffic, not an anomaly, and a short
 * window turns that burst into a lockout even when the hourly rate is fine.
 */
/**
 * Sized for a YEAR GROUP behind one address, not a class.
 *
 * The previous numbers (60 per 5 min, 40 per 15 min) were chosen against the
 * sentence "comfortably above a class registering together". A class is
 * thirty. The platform opens to a whole year group, and the shape of launch
 * day is an announcement in an assembly followed by everyone registering at
 * once from the school network -- so the 41st student to sign up in fifteen
 * minutes was going to be locked out and told to wait, which does not help,
 * because their classmates keep spending the budget as fast as it refills.
 *
 * That is the same failure this pair already fixed once at 5/min, surviving a
 * regression test whose floor was only a class.
 *
 * Env-tunable so the cap can be raised during a launch or an assembly WITHOUT
 * a deploy -- the moment you need it raised is the moment you cannot wait for
 * a build.
 *
 * The security control is `strictLimiter` above, keyed per ACCOUNT, and it
 * stays tight. A looser per-IP cap lets one host try more distinct accounts
 * per hour; it still cannot converge on any particular one, which is what
 * password spraying needs.
 */
function envMax(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const loginIpLimiter = rateLimit({
  intervalMs: 5 * 60_000,
  max: envMax('LOGIN_IP_MAX', 300),
});

/**
 * Signup per IP. Still lower than login, because a student registers once and
 * signs in daily -- but 200 in fifteen minutes absorbs an entire year group
 * arriving together, which is precisely what launch day is.
 */
export const signupIpLimiter = rateLimit({
  intervalMs: 15 * 60_000,
  max: envMax('SIGNUP_IP_MAX', 200),
});

/**
 * Competition-vault unlock attempts, keyed to one account.
 *
 * The vault holds 1,398 STEP questions behind either the Konami sequence or a
 * pass-phrase in `COMPETITION_PASSPHRASE`. The Konami path is an easter egg and
 * guards nothing -- anyone can post it -- but the pass-phrase is a shared
 * secret, and the endpoint answered an unlimited number of guesses per second.
 * Ten a minute leaves the intended path (type it, get in) untouched while
 * making an online guessing attack pointless.
 *
 * Keyed per account rather than per IP for the reason set out above: a year
 * group shares one egress address, and an IP limit here would let one curious
 * student lock out the class.
 */
export const unlockLimiter = rateLimit({ intervalMs: 60_000, max: 10 });

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

let warnedCapOff = false;

/**
 * Whether to skip the monthly reservation entirely.
 *
 * The predicate itself lives in `lib/spend-cap.ts` so it can be tested; this
 * reads the environment per call, matching the other env reads here, so a
 * process that populates its environment late sees what the request path will.
 *
 * **What still protects the owner when this is off.** `aiLimiter` is untouched
 * and caps every account at 20 AI requests a minute, so no single student can
 * burn credit quickly. What disappears is the per-account *cumulative* bound:
 * nothing then stops one student spending steadily over a month.
 * AI_MONTHLY_TOTAL_SPEND_LIMIT_USD is the backstop, and it is checked whether
 * or not this one runs — switching this off removes a student's own allowance,
 * never the platform's.
 */
function monthlyCapOff(): boolean {
  const off = isMonthlyCapDisabled(process.env.AI_MONTHLY_USER_SPEND_LIMIT_USD);
  if (off && !warnedCapOff) {
    warnedCapOff = true;
    console.warn(
      '[rate-limit] AI_MONTHLY_USER_SPEND_LIMIT_USD is off: shared-key AI spend '
      + 'is bounded only by the per-minute limiter, with no monthly ceiling.',
    );
  }
  return off;
}
const AI_REQUEST_RESERVE_USD = positiveNumber(
  process.env.AI_REQUEST_RESERVE_USD,
  0.02,
);

/**
 * Platform-wide monthly ceiling on shared-key AI, in USD.
 *
 * The per-user cap above answers "can one student run up a bill?". This
 * answers the question that replaced it once the shared key was opened to
 * everyone and the per-user cap was switched off: "can the year group, or one
 * student in a loop, drain the credit the gateway's operator donated?".
 *
 * That is not hypothetical arithmetic. With the per-user cap off the only
 * remaining bound is `aiLimiter` at 20 requests a minute *each*, which is
 * ~29,000 requests a day for a single account. The credit behind the shared
 * key is a fixed gift from a person, not a metered company account, and there
 * is no billing alert behind it -- so the ceiling has to live here.
 *
 * $500 is a deliberate default rather than a round guess. At the flat
 * AI_REQUEST_RESERVE_USD ($0.02) this is 25,000 shared requests a month, which
 * is ~125 each for a 200-student year group and far more than observed use,
 * while capping the worst month at a twentieth of the donated credit.
 *
 * It may be switched off with the same vocabulary as the per-user cap, but
 * losing the variable must not be the same as turning it off -- hence the
 * fallback here, pinned by a test.
 */
const AI_MONTHLY_TOTAL_SPEND_LIMIT_USD = positiveNumber(
  process.env.AI_MONTHLY_TOTAL_SPEND_LIMIT_USD,
  500,
);

let warnedTotalCapOff = false;

/** Whether the platform-wide ceiling is switched off. Explicit words only. */
function totalCapOff(): boolean {
  const off = isMonthlyCapDisabled(process.env.AI_MONTHLY_TOTAL_SPEND_LIMIT_USD);
  if (off && !warnedTotalCapOff) {
    warnedTotalCapOff = true;
    console.warn(
      '[rate-limit] AI_MONTHLY_TOTAL_SPEND_LIMIT_USD is off: there is no ceiling '
      + 'of any kind on what the shared key can spend this month.',
    );
  }
  return off;
}

function startOfNextUtcMonth(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Reserve against one monthly budget row.
 *
 * Shared by the per-user ceiling and the platform-wide one, because the SQL
 * below is the whole correctness argument and having two copies of it is how
 * they drift. The caller supplies the key and the cap; everything else --
 * reserve-before-calling, never refund, fail closed -- is policy that must be
 * identical for both.
 */
async function reserveSpend(
  key: string,
  capUsd: number,
  requests: number,
  label: string,
): Promise<'allowed' | 'budget' | 'unavailable'> {
  const now = new Date();
  const safeRequests = Math.max(1, Math.min(100, Math.ceil(requests)));
  const reserveMicroUsd = Math.max(
    1,
    Math.ceil(AI_REQUEST_RESERVE_USD * safeRequests * MICRO_USD_PER_USD),
  );
  const capMicroUsd = Math.max(1, Math.floor(capUsd * MICRO_USD_PER_USD));
  if (reserveMicroUsd > capMicroUsd) return 'budget';

  const resetAt = startOfNextUtcMonth(now);

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
    console.error('[ai-spend-limit] failed to reserve %s budget:', label, error);
    // Paid operations fail closed when their durable spend control cannot be
    // verified. A database outage prevents the surrounding route from doing
    // useful work anyway, and allowing the provider call would remove the cap.
    return 'unavailable';
  }
}

/** One student's monthly ceiling. */
function reserveMonthlyAiSpend(userId: string, requests: number) {
  const month = new Date().toISOString().slice(0, 7);
  return reserveSpend(
    `ai-spend:${month}:${userId}`,
    AI_MONTHLY_USER_SPEND_LIMIT_USD,
    requests,
    `user ${userId}`,
  );
}

/**
 * Everyone's monthly ceiling, against one row.
 *
 * A single hot row is the point -- it is what makes the bound global -- and it
 * is affordable here: the statement is one upsert on a primary key, and every
 * AI request already costs a provider round-trip measured in seconds, so
 * serialising for well under a millisecond on this row changes nothing a
 * student can perceive.
 */
function reserveTotalAiSpend(requests: number) {
  const month = new Date().toISOString().slice(0, 7);
  return reserveSpend(
    `ai-spend-total:${month}`,
    AI_MONTHLY_TOTAL_SPEND_LIMIT_USD,
    requests,
    'platform',
  );
}

/**
 * How much of the platform-wide ceiling is gone, for the admin console.
 *
 * Read-only and deliberately tolerant: this is a status panel, and a failed
 * read must not take the console down with it. `null` means "cannot say",
 * which the UI renders as such rather than as a comforting zero.
 *
 * `usedUsd` is reserved rather than billed. Reservations are flat and never
 * refunded, so this runs ahead of the real bill on cheap calls -- which is the
 * right direction for a control whose job is to not run out.
 */
export async function readSharedAiBudget(): Promise<{
  limitUsd: number | null;
  usedUsd: number;
  resetsAt: string;
} | null> {
  const month = new Date().toISOString().slice(0, 7);
  const resetsAt = startOfNextUtcMonth().toISOString().slice(0, 10);
  const limitUsd = totalCapOff() ? null : AI_MONTHLY_TOTAL_SPEND_LIMIT_USD;
  try {
    const rows = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT "count" FROM rate_limits
      WHERE "key" = ${`ai-spend-total:${month}`} AND "resetAt" > now()
    `;
    return { limitUsd, usedUsd: Number(rows[0]?.count ?? 0) / MICRO_USD_PER_USD, resetsAt };
  } catch (error) {
    console.error('[ai-spend-limit] could not read the platform budget:', error);
    return null;
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

  // Nor does a shared key with no bill behind it. The reservations below are a
  // flat AI_REQUEST_RESERVE_USD ($0.02) per request and are deliberately never
  // refunded, so they are really request quotas wearing a dollar sign --
  // whatever the calls actually cost. That is the right shape when the shared
  // key is genuinely free, and FREE_MODELS is empty today, so this never fires
  // and the caps apply to every shared call, which is correct: the current
  // gateway bills someone for all of them.
  if (sharedModelIsFree()) return { allowed: true };

  const resets = startOfNextUtcMonth().toISOString().slice(0, 10);
  const requests = options.requests ?? 1;

  /**
   * Per-user first, platform-wide second, and the order is deliberate.
   *
   * Both reservations are taken before the provider call and neither is ever
   * refunded, so a request denied by the *second* check has still consumed
   * budget from the first. Denying on the personal allowance first means an
   * individual hitting their own limit cannot nibble away at everyone else's
   * ceiling -- the reverse order would let one looping account drain the
   * shared budget through requests it was never allowed to make.
   *
   * The per-user cap may be switched off (it is, in production, so that every
   * student can use the tutor). The platform-wide one is what remains, and it
   * is checked whether or not the personal one ran.
   */
  if (!monthlyCapOff()) {
    const monthly = await reserveMonthlyAiSpend(userId, requests);
    if (monthly === 'budget') {
      return {
        allowed: false,
        reason: 'budget',
        message: `Your monthly AI allowance has been reached. It resets on ${resets}.`,
      };
    }
    if (monthly === 'unavailable') return unavailable();
  }

  if (!totalCapOff()) {
    const total = await reserveTotalAiSpend(requests);
    if (total === 'budget') {
      return {
        allowed: false,
        reason: 'budget',
        // Not the student's fault and not their allowance, so it must not read
        // like either. Naming the personal-key route matters: it is the one
        // thing they can actually do about it, and it costs the platform
        // nothing when they do.
        message:
          'The shared AI budget for this month has been used up, so AI features are '
          + `paused for everyone until ${resets}. You can carry on straight away by `
          + 'adding your own API key in Account Settings → AI Provider.',
      };
    }
    if (total === 'unavailable') return unavailable();
  }

  return { allowed: true };
}

function unavailable(): AiAllowance {
  return {
    allowed: false,
    reason: 'unavailable',
    message: 'AI is temporarily unavailable because usage controls could not be verified. Please try again.',
  };
}

/**
 * Record an AI usage event for the Usage & API Credits dashboard.
 *
 * When `cost` is not supplied it is estimated from the token counts and the
 * per-model price table (lib/ai-pricing.ts); with no counts either, cost
 * stays at zero. Failure recording uses a `<feature>:error` feature label so
 * the by-feature breakdowns in both the admin console and the user usage page
 * show attempts that never produced an answer instead of hiding them.
 *
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
        cost: opts.cost ?? estimateCostUsd(opts.model, opts.tokensIn ?? 0, opts.tokensOut ?? 0),
        model: opts.model ?? 'deepseek-chat',
      },
    });
  } catch (err) {
    // Best-effort; never let telemetry break the request — but log so a
    // misconfigured table or bad payload doesn't fail silently.
    console.error('[recordUsage] failed to log usage:', err);
  }
}
