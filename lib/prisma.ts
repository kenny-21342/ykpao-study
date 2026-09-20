import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { getDatabaseUrl } from './env'
import { databaseSsl } from './db-ssl'

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
 * Five is deliberately modest: this serves a school year group, the queries
 * are short, and a connection waiting in a pool is worth less here than a
 * connection left available to the next instance. Raise `DB_POOL_MAX` on a
 * plan that can afford it -- `.github/workflows/db-restore.yml` reports the
 * server's `max_connections` in its preflight.
 */
function poolMax(name: string, fallback: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

const connectionString = getDatabaseUrl()
const ssl = databaseSsl(connectionString)

const pool = new Pool({
  connectionString,
  max: poolMax('DB_POOL_MAX', 5),
  ...(ssl === undefined ? {} : { ssl }),
})

const adapter = new PrismaPg(pool)

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
