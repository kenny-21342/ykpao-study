/**
 * Rasterises public/icon.svg into the PNG sizes a PWA install actually
 * requires. iOS Safari and older Android will not offer "Add to Home Screen"
 * for a manifest that lists only an SVG icon.
 *
 * Run with `npm run icons:build` after changing icon.svg. The outputs are
 * committed, so a normal build does not need sharp at all.
 */
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const svg = await readFile(join(publicDir, 'icon.svg'));

// The icon's own tile colour, used wherever the output must be opaque (Apple
// ignores transparency and composites onto black) or padded (Android's
// maskable safe zone). It has to match the `rect` fill in icon.svg exactly --
// this was still the pre-restyle emerald while the tile had moved to the
// accent, so the maskable icon carried a visibly different green border around
// a differently green square.
const BRAND = '#1A7F4B';

for (const size of [192, 512]) {
  await sharp(svg, { density: 512 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(join(publicDir, `icon-${size}.png`));
}

// Maskable icons are cropped to the inner 80% "safe zone" by Android's
// adaptive-icon masks, so the artwork is inset and the gap filled with brand
// colour rather than letting the mask bite into the glyph.
// `flatten` before `extend` is load-bearing: icon.svg's tile has rounded
// corners, so the inset copy carries four transparent corners into the middle
// of the maskable icon, where a mask cannot crop them away. Without it Android
// showed the launcher background through the corners of the green square.
await sharp(svg, { density: 512 })
  .resize(410, 410)
  .flatten({ background: BRAND })
  .extend({ top: 51, bottom: 51, left: 51, right: 51, background: BRAND })
  .png({ compressionLevel: 9 })
  .toFile(join(publicDir, 'icon-maskable-512.png'));

await sharp(svg, { density: 512 })
  .resize(180, 180)
  .flatten({ background: BRAND })
  .png({ compressionLevel: 9 })
  .toFile(join(publicDir, 'apple-touch-icon.png'));

/*
 * favicon.ico. Modern browsers take the SVG from `metadata.icons`, but a
 * browser that has not parsed the document yet still requests /favicon.ico by
 * convention -- and before this file existed, that request 404d. The three
 * sizes are what actually get used: 16 in a tab, 32 on a retina tab, 48 in
 * bookmark and history lists.
 *
 * An .ico is a directory of images; every browser in use accepts PNG-compressed
 * entries, so each size is a plain PNG with a 16-byte header entry in front.
 * Written by hand because sharp has no .ico encoder.
 */
const icoSizes = [16, 32, 48];
const icoImages = await Promise.all(
  icoSizes.map((size) =>
    sharp(svg, { density: 1024 })
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toBuffer(),
  ),
);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // 1 = icon
header.writeUInt16LE(icoSizes.length, 4);

let offset = 6 + 16 * icoSizes.length;
const entries = icoImages.map((png, i) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(icoSizes[i], 0); // width  (0 would mean 256)
  entry.writeUInt8(icoSizes[i], 1); // height
  entry.writeUInt8(0, 2); // palette size, 0 for truecolour
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += png.length;
  return entry;
});

// app/, not public/: this is where the App Router looks for it, and Next then
// serves it at /favicon.ico and links it itself.
await writeFile(
  join(root, 'app', 'favicon.ico'),
  Buffer.concat([header, ...entries, ...icoImages]),
);

console.log('[build-icons] wrote icon-192, icon-512, icon-maskable-512, apple-touch-icon, favicon.ico');
