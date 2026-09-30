import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extensionOf, outputNaming, planImageCompression, scaleToFit,
} from '../lib/image-compress.ts';
import {
  IMAGE_COMPRESS_TARGET_BYTES, IMAGE_PICK_MAX_BYTES, RESOURCE_UPLOAD_MAX_BYTES,
} from '../lib/upload-constants.ts';

const MB = 1024 * 1024;
const f = (name: string, mb: number) => ({ name, size: Math.round(mb * MB) });

test('a phone photo over the wire limit is compressed, not refused', () => {
  const plan = planImageCompression(f('IMG_4821.jpg', 12));
  assert.equal(plan.action, 'compress');
});

test('an image already under the wire limit is left exactly as chosen', () => {
  // Re-encoding is lossy; doing it needlessly costs quality for no benefit.
  assert.equal(planImageCompression(f('small.png', 1)).action, 'passthrough');
});

test('an image over the pick limit is refused, naming the pick limit', () => {
  const plan = planImageCompression(f('huge.png', 25));
  assert.equal(plan.action, 'reject');
  assert.match((plan as { reason: string }).reason, /20 MB/);
});

test('a GIF is never sent to the canvas', () => {
  // Drawing an animated GIF to a canvas keeps one frame and throws the
  // animation away. Refusing an oversized one is the honest outcome.
  assert.equal(planImageCompression(f('anim.gif', 8)).action, 'reject');
  assert.equal(planImageCompression(f('anim.gif', 1)).action, 'passthrough');
});

test('an oversized document is refused against the wire limit, not 20 MB', () => {
  const plan = planImageCompression(f('paper.pdf', 12));
  assert.equal(plan.action, 'reject');
  assert.match((plan as { reason: string }).reason, /4 MB/);
  assert.doesNotMatch((plan as { reason: string }).reason, /20 MB/);
});

test('a document under the wire limit passes through', () => {
  assert.equal(planImageCompression(f('notes.pdf', 2)).action, 'passthrough');
});

test('the compressor targets a size below the wire ceiling', () => {
  // Multipart framing rides on top of the bytes, so hitting the ceiling
  // exactly would still be rejected at the edge.
  assert.ok(IMAGE_COMPRESS_TARGET_BYTES < RESOURCE_UPLOAD_MAX_BYTES);
  assert.ok(IMAGE_PICK_MAX_BYTES > RESOURCE_UPLOAD_MAX_BYTES);
});

test('downscaling keeps aspect ratio and never enlarges', () => {
  assert.deepEqual(scaleToFit(4032, 3024, 2560), { width: 2560, height: 1920 });
  assert.deepEqual(scaleToFit(800, 600, 2560), { width: 800, height: 600 });
  assert.deepEqual(scaleToFit(3024, 4032, 2560), { width: 1920, height: 2560 });
});

test('a very thin image never scales to a zero dimension', () => {
  const out = scaleToFit(20000, 3, 2560);
  assert.ok(out.height >= 1, 'a zero-height canvas throws on drawImage');
});

test('the name follows the bytes the encoder actually produced', () => {
  // /api/upload refuses any disagreement between extension, declared MIME and
  // magic number, so a PNG re-encoded as WebP must stop being called .png.
  assert.deepEqual(outputNaming('photo.png', 'image/webp'), { name: 'photo.webp', mime: 'image/webp' });
  assert.deepEqual(outputNaming('photo.png', 'image/png'), { name: 'photo.png', mime: 'image/png' });
  assert.deepEqual(outputNaming('IMG.JPEG', 'image/jpeg'), { name: 'IMG.jpg', mime: 'image/jpeg' });
});

test('a dotted or extensionless name still yields one clean extension', () => {
  assert.equal(outputNaming('my.holiday.photo.jpg', 'image/webp').name, 'my.holiday.photo.webp');
  assert.equal(outputNaming('screenshot', 'image/webp').name, 'screenshot.webp');
});

test('extensionOf handles the cases that would mis-route a file', () => {
  assert.equal(extensionOf('a.JPG'), '.jpg');
  assert.equal(extensionOf('noext'), '');
  assert.equal(extensionOf('.gitignore'), '', 'a dotfile has no extension');
  assert.equal(extensionOf('trailing.'), '');
});
