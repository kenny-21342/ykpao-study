/**
 * Rasterises public/icon.svg into the PNG sizes a PWA install actually
 * requires. iOS Safari and older Android will not offer "Add to Home Screen"
 * for a manifest that lists only an SVG icon.
 *
 * Run with `npm run icons:build` after changing icon.svg. The outputs are
 * committed, so a normal build does not need sharp at all.
 */
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const svg = await readFile(join(publicDir, 'icon.svg'));

// The brand green the icon's gradient starts from; used wherever the output
// must be opaque (Apple ignores transparency and composites onto black).
const BRAND = '#10b981';

for (const size of [192, 512]) {
  await sharp(svg, { density: 512 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(join(publicDir, `icon-${size}.png`));
}

// Maskable icons are cropped to the inner 80% "safe zone" by Android's
// adaptive-icon masks, so the artwork is inset and the gap filled with brand
// colour rather than letting the mask bite into the glyph.
await sharp(svg, { density: 512 })
  .resize(410, 410)
  .extend({ top: 51, bottom: 51, left: 51, right: 51, background: BRAND })
  .png({ compressionLevel: 9 })
  .toFile(join(publicDir, 'icon-maskable-512.png'));

await sharp(svg, { density: 512 })
  .resize(180, 180)
  .flatten({ background: BRAND })
  .png({ compressionLevel: 9 })
  .toFile(join(publicDir, 'apple-touch-icon.png'));

console.log('[build-icons] wrote icon-192, icon-512, icon-maskable-512, apple-touch-icon');
