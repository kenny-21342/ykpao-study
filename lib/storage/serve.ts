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

export async function serveStoredObject(pathSegments: string[]): Promise<Response> {
  const key = keyFromPublicPath(pathSegments.join('/'));
  if (!key) {
    return new Response('Not found', { status: 404 });
  }

  const store = getStorage();

  try {
    // Prefer handing the browser a direct URL — it keeps large files off the
    // function's response path entirely.
    const signedUrl = await store.signedGetUrl(key);
    if (signedUrl) {
      return Response.redirect(signedUrl, 307);
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
