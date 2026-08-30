import { getStorage } from './index.ts';
import { keyFromPublicPath } from './keys.ts';

/**
 * Serve a stored object at its historical public URL.
 *
 * Uploads, extracted diagrams and STEP images were static files under
 * `public/`, and their paths (`/uploads/images/<uuid>.png`) are recorded in
 * thousands of database rows, embedded in note HTML, and checked with
 * `startsWith('/uploads/')` in half a dozen routes. Rather than rewrite all of
 * that, the URLs stay exactly as they are and these handlers resolve them
 * through the object store.
 *
 * In development the matching file usually still exists under `public/`, which
 * Next serves first — so this only takes over where the static file is absent,
 * which is precisely the serverless case.
 */

/** How long a browser may cache an object. Keys are immutable once written. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * How long one presigned URL is reused for, and how long it stays valid.
 *
 * The redirect target has to be the *same* URL across renders or the browser
 * cannot reuse the bytes it already has, so the signature is quantised into
 * three-day windows. The signature itself lasts seven days -- the SigV4
 * ceiling -- which leaves a comfortable margin over the worst case, a redirect
 * cached at the very end of a window and reused for a further three days.
 */
const SIGNED_URL_WINDOW_SECONDS = 3 * 24 * 60 * 60;
const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

/** What the browser may cache, bounded by how long the target stays signable. */
const REDIRECT_CACHE_CONTROL = `private, max-age=${SIGNED_URL_WINDOW_SECONDS}`;
const SIGNED_OBJECT_CACHE_CONTROL = `public, max-age=${SIGNED_URL_WINDOW_SECONDS}, immutable`;

export async function serveStoredObject(pathSegments: string[]): Promise<Response> {
  const key = keyFromPublicPath(pathSegments.join('/'));
  if (!key) {
    return new Response('Not found', { status: 404 });
  }

  const store = getStorage();

  try {
    // Prefer handing the browser a direct URL — it keeps large files off the
    // function's response path entirely.
    //
    // Both cache headers matter. R2 answers with `Cache-Control: no-cache`
    // unless the signature overrides it, and `Response.redirect` sends no cache
    // headers at all, so the old two-line version re-downloaded every crop on
    // every render: a question page with thirty strips paid thirty function
    // invocations and thirty full object reads each time a student opened it.
    const signedUrl = await store.signedGetUrl(key, {
      cacheControl: SIGNED_OBJECT_CACHE_CONTROL,
      stableWindowSeconds: SIGNED_URL_WINDOW_SECONDS,
      expiresInSeconds: SIGNED_URL_TTL_SECONDS,
    });
    if (signedUrl) {
      // `private`, not `public`: the route in front of this is session-gated,
      // and a shared cache must not hand the redirect to a signed-out visitor.
      return new Response(null, {
        status: 307,
        headers: { Location: signedUrl, 'Cache-Control': REDIRECT_CACHE_CONTROL },
      });
    }

    const object = await store.get(key);
    if (!object) {
      return new Response('Not found', { status: 404 });
    }

    return new Response(new Uint8Array(object.bytes), {
      headers: {
        'Content-Type': object.contentType ?? 'application/octet-stream',
        'Content-Length': String(object.size),
        'Cache-Control': CACHE_CONTROL,
        // These are user-uploaded bytes served from our own origin; stop the
        // browser sniffing a .txt into something executable.
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[storage/serve] failed to serve %s:', key, error);
    return new Response('Not found', { status: 404 });
  }
}
