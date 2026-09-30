/**
 * Shrink a picked image in the browser so it fits through /api/upload.
 *
 * A Vercel function never receives a request body over 4.5 MB, so the wire
 * ceiling (RESOURCE_UPLOAD_MAX_BYTES) is not a policy we can raise -- see the
 * comment where it is defined. A phone photo is routinely 8-20 MB, which made
 * "choose a background image" fail for the most ordinary file a student has.
 *
 * So the file is decoded, downscaled and re-encoded here before anything is
 * posted. A 20 MB photo becomes roughly a megabyte, and the wire ceiling is
 * never approached.
 *
 * The decision logic is separated from the canvas work below so it can be
 * tested without a DOM -- `planImageCompression` is pure.
 */

import {
  COMPRESSIBLE_IMAGE_EXTS,
  IMAGE_COMPRESS_MAX_EDGE,
  IMAGE_COMPRESS_TARGET_BYTES,
  IMAGE_PICK_MAX_BYTES,
  IMAGE_PICK_MAX_LABEL,
  RESOURCE_UPLOAD_MAX_BYTES,
  RESOURCE_UPLOAD_MAX_LABEL,
} from './upload-constants.ts';

export type CompressionPlan =
  /** Post the file unchanged. */
  | { action: 'passthrough' }
  /** Decode, downscale and re-encode before posting. */
  | { action: 'compress'; maxEdge: number; targetBytes: number }
  /** Do not post at all; show `reason`. */
  | { action: 'reject'; reason: string };

/** Lower-cased extension including the dot, or '' when there is none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot).toLowerCase();
}

/**
 * Decide what to do with a picked file, from its name and size alone.
 *
 * Deliberately does not decode anything: this runs the moment a file is
 * chosen, to decide whether to refuse it outright or hand it to the canvas.
 */
export function planImageCompression(file: { name: string; size: number }): CompressionPlan {
  const ext = extensionOf(file.name);

  // Not something we can re-encode. An animated GIF is excluded on purpose:
  // drawing it to a canvas keeps a single frame and silently throws the
  // animation away, which is worse than refusing an oversized one.
  if (!COMPRESSIBLE_IMAGE_EXTS.has(ext)) {
    if (file.size > RESOURCE_UPLOAD_MAX_BYTES) {
      return {
        action: 'reject',
        reason: `That file is too large (max ${RESOURCE_UPLOAD_MAX_LABEL}). Only photos can be shrunk automatically.`,
      };
    }
    return { action: 'passthrough' };
  }

  // Already small enough. Leave it exactly as chosen rather than re-encoding
  // it for nothing -- re-encoding is lossy, so doing it needlessly costs
  // quality for no benefit.
  if (file.size <= RESOURCE_UPLOAD_MAX_BYTES) {
    return { action: 'passthrough' };
  }

  if (file.size > IMAGE_PICK_MAX_BYTES) {
    return {
      action: 'reject',
      reason: `That image is too large (max ${IMAGE_PICK_MAX_LABEL}).`,
    };
  }

  return {
    action: 'compress',
    maxEdge: IMAGE_COMPRESS_MAX_EDGE,
    targetBytes: IMAGE_COMPRESS_TARGET_BYTES,
  };
}

/**
 * Fit `width`x`height` inside a `maxEdge` box, keeping aspect ratio.
 * Never enlarges, and never returns a zero dimension.
 */
export function scaleToFit(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const factor = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/**
 * The name and MIME to send, given what the encoder actually produced.
 *
 * /api/upload cross-checks extension against declared MIME against the bytes'
 * magic number, and rejects on any disagreement. So the three must be changed
 * together: a PNG re-encoded to WebP but still called `.png` is refused with
 * "MIME type does not match extension".
 */
export function outputNaming(originalName: string, producedMime: string): { name: string; mime: string } {
  const ext = producedMime === 'image/webp' ? '.webp'
    : producedMime === 'image/jpeg' ? '.jpg'
    : '.png';
  const mime = producedMime === 'image/webp' ? 'image/webp'
    : producedMime === 'image/jpeg' ? 'image/jpeg'
    : 'image/png';
  const dot = originalName.lastIndexOf('.');
  const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
  return { name: `${stem || 'image'}${ext}`, mime };
}

/** Quality ladder walked until the encoded blob comes in under target. */
const QUALITY_STEPS = [0.85, 0.7, 0.55, 0.4];

/**
 * Apply `planImageCompression` to a real file.
 *
 * Returns the file to post. Throws with a readable message when the plan is to
 * reject, or when the image cannot be decoded at all.
 *
 * Browser-only: uses createImageBitmap and canvas.
 */
export async function prepareImageForUpload(file: File): Promise<File> {
  const plan = planImageCompression(file);
  if (plan.action === 'passthrough') return file;
  if (plan.action === 'reject') throw new Error(plan.reason);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That image could not be read. Try a JPEG or PNG.');
  }

  try {
    let maxEdge = plan.maxEdge;

    // Walk quality down first, then dimensions: dropping quality is much less
    // visible than dropping resolution, so spend it first.
    for (let pass = 0; pass < 3; pass++) {
      const { width, height } = scaleToFit(bitmap.width, bitmap.height, maxEdge);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('That image could not be processed in this browser.');
      ctx.drawImage(bitmap, 0, 0, width, height);

      for (const quality of QUALITY_STEPS) {
        const blob = await canvasToBlob(canvas, 'image/webp', quality);
        if (!blob) continue;
        if (blob.size <= plan.targetBytes) {
          // Trust what came back, not what was asked for: a browser without
          // WebP encoding silently hands back a PNG, and the name and MIME
          // have to follow the bytes or the route refuses the upload.
          const { name, mime } = outputNaming(file.name, blob.type || 'image/webp');
          return new File([blob], name, { type: mime });
        }
      }
      maxEdge = Math.round(maxEdge * 0.7);
    }

    throw new Error('That image could not be made small enough to upload. Try a smaller one.');
  } finally {
    bitmap.close?.();
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
