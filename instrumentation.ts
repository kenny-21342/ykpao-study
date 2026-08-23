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
 * Next calls this for every error it catches on the server, which makes it the
 * one place worth wiring: no handler has to remember to report anything. See
 * lib/error-reporting.ts for where it goes.
 *
 * Imported lazily so the Edge runtime -- which has no Prisma -- never pulls it
 * in, and so a failure to load the reporter cannot take down the server.
 */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string }
) {
  const digest =
    typeof error === 'object' && error !== null && 'digest' in error
      ? String((error as { digest: unknown }).digest)
      : undefined;

  // The reporter writes through Prisma, which the Edge runtime cannot load --
  // the same reason `register()` above returns early there. Only `proxy.ts`
  // runs on Edge, so this trades recording proxy errors (which still reach the
  // platform log) for keeping Prisma out of the Edge bundle entirely.
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    console.error('[request-error/edge] %s %s:', request.method, request.path, error);
    return;
  }

  try {
    const { reportError } = await import('./lib/error-reporting.ts');
    await reportError(error, {
      path: request.path,
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
      digest,
      source: 'request',
    });
  } catch (err) {
    console.error('[request-error] reporter unavailable:', err, error);
  }
}
