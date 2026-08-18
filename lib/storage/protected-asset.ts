/**
 * Session gate for the three historical asset URL prefixes.
 *
 * `/uploads/**`, `/extracted_images/**` and `/step-images/**` were static files
 * under `public/` before object storage existed, and their URLs are recorded in
 * thousands of database rows and embedded in stored note HTML. The paths must
 * therefore stay exactly as they are — only who may read them changes.
 *
 * All three carry material that is private to the cohort: student uploads,
 * diagrams cropped out of copyrighted past papers, and worked-solution imagery
 * for STEP questions. UUID and paper-stem filenames make them hard to guess,
 * but guessability is not a permission check — once a URL leaks (a shared
 * screenshot, a referrer header, a browser-synced history) it is world
 * readable forever, because the objects are immutable and cached for a year.
 *
 * The gate is deliberately the JWT session only, not `getSessionUser()`:
 * a single question page pulls dozens of diagrams, and a database round trip
 * per image would multiply page-load queries for no gain in a threat model
 * where the attacker has no session at all. The trade-off is that a banned
 * user's unexpired token still resolves images until it lapses; every route
 * that exposes *new* material still goes through `getSessionUser()`.
 */

/** The shape of a NextAuth session this gate cares about. */
export type AssetSession = { user?: { id?: string | null } | null } | null;

/** Storage prefixes that may be served through this gate. */
export type AssetPrefix = 'uploads' | 'extracted_images' | 'step-images';

export type ProtectedAssetDeps = {
  /** Reads the current session. Injected so tests can drive the gate directly. */
  getSession: () => Promise<AssetSession>;
  /** Resolves the object once access is granted. Defaults to the object store. */
  serve?: (pathSegments: string[]) => Promise<Response>;
};

function unauthorized(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'Cache-Control': 'no-store' },
  });
}

/**
 * Authenticate, then serve. Storage is never touched until the session has
 * been established, and any failure to establish one — a missing session, a
 * malformed token, an exception out of NextAuth — denies the request.
 */
export async function serveProtectedAsset(
  prefix: AssetPrefix,
  path: string[],
  deps: ProtectedAssetDeps
): Promise<Response> {
  let session: AssetSession;
  try {
    session = await deps.getSession();
  } catch (error) {
    // Fail closed. A session backend that throws (a missing NEXTAUTH_SECRET,
    // an unreachable provider) must not degrade into anonymous access.
    console.error('[storage/protected-asset] session lookup failed:', error);
    return unauthorized();
  }

  if (!session?.user?.id) return unauthorized();

  const serve =
    deps.serve ??
    (async (segments: string[]) => {
      const { serveStoredObject } = await import('./serve.ts');
      return serveStoredObject(segments);
    });

  return serve([prefix, ...path]);
}
