/**
 * YKPao Study service worker.
 *
 * Strategy:
 *   - Precache the app shell (HTML routes) on install.
 *   - Stale-while-revalidate for static assets (_next/static, fonts, images).
 *   - Network-first for API reads so fresh data is always preferred, but fall
 *     back to cache when offline (lets students review cached notes/questions).
 *   - The /api/notifications/stream SSE endpoint is bypassed entirely.
 *
 * DO NOT EDIT public/sw.js — it is generated from this file by
 * scripts/build-sw.mjs, which stamps in a per-build CACHE_VERSION. Edit this
 * template instead.
 */

// Replaced at build time with a hash of the build. Bumping this on every
// deploy is what evicts the previous build's caches; the old hand-maintained
// 'v1' constant never changed, so a returning user kept last deploy's HTML —
// which references _next/static chunks that no longer exist — and white-screened.
const CACHE_VERSION = '__CACHE_VERSION__';
const SHELL_CACHE = `ykpao-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `ykpao-assets-${CACHE_VERSION}`;
const API_CACHE = `ykpao-api-${CACHE_VERSION}`;

// Routes that make up the offline "app shell" — precached on install.
const SHELL_ROUTES = ['/', '/auth/login'];

// Path prefixes for runtime caching strategies.
const STATIC_ASSET_RE = /\/_next\/static\//;
const IMAGE_FONT_RE = /\.(?:png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|css)$/i;
const READ_API_RE = /^\/api\/(notes|questions|review|flashcards|dashboard|daily-challenge|weaknesses|platform-stats)/;
const BYPASS_RE = /\/api\/notifications\/stream/; // SSE — never cache

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // best-effort; don't block install on a failed route.
      await Promise.all(
        SHELL_ROUTES.map((url) =>
          fetch(url, { cache: 'reload' })
            .then((res) => res.ok && cache.put(url, res.clone()))
            .catch(() => {})
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => ![SHELL_CACHE, ASSET_CACHE, API_CACHE].includes(k))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GET requests. Let everything else pass through.
  if (url.origin !== self.location.origin) return;
  if (req.method !== 'GET') return;
  if (BYPASS_RE.test(url.pathname)) return;

  // ---- Static assets: stale-while-revalidate ----
  if (STATIC_ASSET_RE.test(url.pathname) || IMAGE_FONT_RE.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(req, ASSET_CACHE));
    return;
  }

  // ---- API reads: network-first with cache fallback ----
  if (READ_API_RE.test(url.pathname)) {
    event.respondWith(networkFirst(req, API_CACHE));
    return;
  }

  // ---- Navigation requests: app-shell fallback ----
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          // Only the shell routes are cached. Caching *every* navigation meant
          // arbitrary deep links were stored as HTML that pins a specific
          // build's asset URLs, multiplying the stale-build failure surface.
          if (fresh.ok && SHELL_ROUTES.includes(url.pathname)) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put(url.pathname, fresh.clone()).catch(() => {});
          }
          return fresh;
        } catch {
          // Offline — try the exact URL, then fall back to the cached shell.
          const cached = await caches.match(req.url);
          return cached || (await caches.match('/')) || Response.error();
        }
      })()
    );
    return;
  }
});

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok && res.type === 'basic') {
        cache.put(req, res.clone()).catch(() => {});
      }
      return res;
    })
    .catch(() => cached);
  return cached || network;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch {
    const cached = await cache.match(req);
    return cached || Response.error();
  }
}
