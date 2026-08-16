import type { MetadataRoute } from 'next';

/**
 * Web App Manifest — makes YKPao Study installable as a PWA so students can
 * launch it from their home screen and study offline (cached questions + notes).
 *
 * See https://nextjs.org/docs/app/api-reference/file-conventions/metadata/manifest
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'YKPao Study — Intelligent Learning Platform',
    short_name: 'YKPao Study',
    description:
      'Guided study, practice, and materials for students.',
    start_url: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#ffffff',
    theme_color: '#10b981',
    categories: ['education', 'productivity'],
    icons: [
      // SVG icon scales to any size and is preferred by modern browsers.
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      // iOS Safari and older Android refuse to install a PWA that offers only
      // an SVG, so raster fallbacks at the two required sizes are mandatory,
      // not decorative. Generated from icon.svg — see scripts/build-icons.mjs.
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Padded into the inner 80% safe zone so Android's adaptive-icon mask
      // doesn't crop the glyph.
      {
        src: '/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      {
        name: 'Study',
        short_name: 'Study',
        url: '/?tab=study',
        description: 'Open your plan, review, and mastery area',
      },
      {
        name: 'Practice',
        short_name: 'Practice',
        url: '/?tab=practice',
        description: 'Browse and answer past-paper questions',
      },
    ],
  };
}
