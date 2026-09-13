import type { MetadataRoute } from 'next';
import { appOrigin } from '@/lib/email';

/**
 * Only the pages a signed-out visitor can actually read.
 *
 * Listing app routes here would be worse than listing nothing: each one
 * answers a crawler with a redirect to the login page, which reads as a site
 * full of duplicate content.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = appOrigin();
  const lastModified = new Date();

  return [
    { url: origin, lastModified, changeFrequency: 'weekly', priority: 1 },
    { url: `${origin}/auth/signup`, lastModified, changeFrequency: 'yearly', priority: 0.5 },
    { url: `${origin}/auth/login`, lastModified, changeFrequency: 'yearly', priority: 0.5 },
    { url: `${origin}/terms`, lastModified, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${origin}/privacy`, lastModified, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
