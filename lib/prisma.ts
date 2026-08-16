import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { getDatabaseUrl } from './env'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// For Prisma 7, we need to use an adapter.
//
// `new Pool({ connectionString: undefined })` does NOT throw — pg silently
// falls back to PGHOST/PGUSER/localhost defaults, so a deploy with no
// DATABASE_URL starts up fine and then fails one query at a time with
// confusing connection errors. Fail loudly at import instead.
const pool = new Pool({
  connectionString: getDatabaseUrl(),
})

const adapter = new PrismaPg(pool)

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
})

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
