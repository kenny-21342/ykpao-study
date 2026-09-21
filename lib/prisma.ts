import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { getDatabaseUrl } from './env'
import { pgConfig } from './db-ssl'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// For Prisma 7, we need to use an adapter.
//
// `new Pool({ connectionString: undefined })` does NOT throw — pg silently
// falls back to PGHOST/PGUSER/localhost defaults, so a deploy with no
// DATABASE_URL starts up fine and then fails one query at a time with
// confusing connection errors. Fail loudly at import instead.
/**
 * Pool size, per running instance.
 *
 * `pg` defaults to 10, and `lib/page-pubsub.ts` opens a second pool of its
 * own, so an unconfigured deployment asks a server for up to 30 connections
 * per instance -- multiplied by however many serverless instances are warm.
 * That is fine against a database that allows hundreds and fatal against a
 * small managed plan, where `max_connections` can sit near 20 and the
 * failure is not a slow query but `too many clients already` on every route
 * at once.
 *
 * Three is deliberately small, and the reason is specific to serverless. A
 * frozen instance cannot run its own timers, so `pg`'s idle reaping does not
 * happen between requests: a warm instance holds its sockets until the
 * platform recycles it. Connections therefore scale with *warm instances*,
 * which the platform decides, not with users, which we could reason about.
 *
 * Measured on 21 Sep 2026 against a 20-connection plan with almost no
 * traffic: 12 held connections, and a local script was refused with
 * `53300: remaining connection slots are reserved for roles with the
 * SUPERUSER attribute`. At 5 + 5 per instance, two warm instances were the
 * whole budget.
 *
 * Fluid Compute serves many concurrent requests per instance, so a small
 * pool costs a little queueing and buys room for more instances to exist at
 * all. Raise `DB_POOL_MAX` behind a real connection pooler, or on a plan
 * with more slots -- `scripts/db-size.mjs` reports current usage.
 */
function poolMax(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

const pool = new Pool({
  ...pgConfig(getDatabaseUrl()),
  max: poolMax('DB_POOL_MAX', 3),
})

const adapter = new PrismaPg(pool)

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
