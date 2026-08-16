/**
 * Startup hooks. `register()` runs once when a Next.js server instance boots,
 * before it accepts any request.
 *
 * Its job here is to make configuration mistakes loud. `lib/env.ts` was written
 * to catch the silent failures — `pg` falling back to a localhost socket when
 * DATABASE_URL is unset, NextAuth signing sessions with a development default,
 * an empty ADMIN_EMAILS leaving nobody able to reach /admin, a serverless deploy
 * still reading bulk assets off a read-only filesystem — but nothing ever called
 * it, so every one of those still failed one request at a time in production.
 */

export async function register() {
  // Only the Node.js server runtime: the Edge runtime has no pg and no
  // filesystem, and the checks below are about neither.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // `next build` also invokes register() while prerendering. A build machine
  // legitimately has no DATABASE_URL and no storage credentials, so validating
  // there would fail the build this is meant to protect the runtime from.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { getEnv } = await import('./lib/env.ts');
  getEnv();
}

/**
 * Server-side error reporting hook.
 *
 * There is no error-reporting service wired up yet, so this logs in a single
 * consistent shape rather than leaving errors scattered across handler-specific
 * console calls. Point it at a real provider when one is chosen.
 */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string }
) {
  console.error(
    '[request-error] %s %s (%s %s):',
    request.method,
    request.path,
    context.routerKind,
    context.routeType,
    error
  );
}
