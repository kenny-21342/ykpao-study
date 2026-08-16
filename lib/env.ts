import { z } from 'zod';
import { assertStorageConfigured } from './storage/index.ts';

/**
 * Startup validation for the environment variables the app cannot run without.
 *
 * The failure modes this exists to prevent are all *silent* ones:
 *  - `new Pool({ connectionString: undefined })` does not throw. `pg` falls
 *    back to PGHOST/PGUSER or localhost, so a production deploy with no
 *    DATABASE_URL boots happily and then fails one query at a time.
 *  - NextAuth v4 with no secret signs JWTs with a development fallback, so
 *    every deploy that forgets NEXTAUTH_SECRET issues forgeable sessions.
 *
 * Both are far cheaper to catch at boot than in production traffic.
 */

const isProduction = process.env.NODE_ENV === 'production';

const schema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    ),
  // Either name is accepted; NextAuth v4 reads NEXTAUTH_SECRET, v5 uses AUTH_SECRET.
  NEXTAUTH_SECRET: z.string().optional(),
  AUTH_SECRET: z.string().optional(),
  NEXTAUTH_URL: z.string().url().optional(),
  ADMIN_EMAILS: z.string().optional(),
});

type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;

  const result = schema.safeParse(process.env);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  const env = result.data;
  const problems: string[] = [];

  if (!env.NEXTAUTH_SECRET && !env.AUTH_SECRET) {
    problems.push(
      'NEXTAUTH_SECRET (or AUTH_SECRET) is required — generate one with `openssl rand -base64 32`',
    );
  }

  if (isProduction) {
    // In production these stop being warnings and start being outages.
    if (!env.NEXTAUTH_URL) {
      problems.push(
        'NEXTAUTH_URL must be set in production to the exact public HTTPS origin, or OAuth callbacks redirect to localhost',
      );
    }
    if (!env.ADMIN_EMAILS?.trim()) {
      // Without this there is no bootstrap admin and nobody can reach /admin.
      problems.push(
        'ADMIN_EMAILS must list at least one address in production, or no account can access the admin console',
      );
    }
    // Bulk assets (past papers, uploads, question images) are unreachable from
    // a read-only serverless filesystem; catch that here rather than as a wall
    // of 404s.
    try {
      assertStorageConfigured();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }

  cached = env;
  return env;
}

/**
 * Non-throwing variant for build-time and tooling contexts, where the full
 * production environment legitimately isn't present.
 */
export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and fill it in.',
    );
  }
  return url;
}
