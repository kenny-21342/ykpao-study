import type { MetadataRoute } from 'next';
import { appOrigin } from '@/lib/email';

/**
 * There was no robots.txt at all, so crawlers had no guidance and the whole
 * app -- including every signed-in route, which answers with a redirect -- was
 * fair game to crawl.
 *
 * Only the public pages are worth indexing: everything else either requires a
 * session or is an API. Disallowing them is not a security control (the routes
 * enforce their own auth) but it keeps a crawler from spending its budget on
 * redirects and 401s, and keeps auth URLs carrying tokens out of search
 * results.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/admin', '/account', '/usage', '/auth/verify', '/auth/reset-password'],
    },
    sitemap: `${appOrigin()}/sitemap.xml`,
  };
}
