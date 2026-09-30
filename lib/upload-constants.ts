/**
 * Constants shared between the upload endpoint (/api/upload), the staff-facing
 * Resource Library upload form, and the admin console's resource manager —
 * the three places that must agree on what an acceptable resource file is.
 * Keeping one definition means the client-side checks can never drift from
 * what the server will actually accept.
 */

/** Extensions accepted for school resources and other general uploads. */
export const ALLOWED_RESOURCE_EXTS = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md',
  '.jpg', '.jpeg', '.png', '.webp', '.gif',
]);

/**
 * Per-file ceiling for anything posted to /api/upload as multipart form data.
 *
 * This is NOT a policy choice -- it is the platform's. A Vercel function never
 * receives a request body larger than 4.5 MB: the edge rejects it first, with a
 * `text/plain` body reading "Request Entity Too Large" / FUNCTION_PAYLOAD_TOO_LARGE,
 * so the route's own size check never runs and never gets to answer in JSON.
 *
 * This used to read 25 MB, which was fiction in production: every upload between
 * 4.5 MB and 25 MB passed the client check, got killed at the edge, and surfaced
 * to the student as `Unexpected token 'R', "Request En"... is not valid JSON`
 * -- a client trying to parse that plain-text body as JSON.
 *
 * 4 MB rather than 4.5: multipart framing (boundaries, part headers, the file
 * name) rides on top of the file's own bytes, so a 4.5 MB file exceeds 4.5 MB on
 * the wire. Verified against production -- 4 MB reaches the route, 5 MB does not.
 *
 * Raising this means not sending the bytes through the function at all: presign
 * a PUT straight to the object store (`presignUrl` in lib/storage/sigv4.ts
 * already does the signing for reads) and have the route record only metadata.
 */
export const RESOURCE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

/** The ceiling above, as it should appear in a message to a person. */
export const RESOURCE_UPLOAD_MAX_LABEL = '4 MB';

/**
 * What a person may *pick* when the file is an image.
 *
 * Larger than the wire ceiling above because an image does not travel as
 * chosen: the browser decodes it, downscales it and re-encodes it to WebP
 * before anything is posted (lib/image-compress.ts), so a 20 MB phone photo
 * arrives as roughly a megabyte. The 4 MB ceiling still governs what may cross
 * the wire -- this governs what may go into the compressor.
 *
 * Documents cannot be re-encoded, so they stay on RESOURCE_UPLOAD_MAX_BYTES.
 */
export const IMAGE_PICK_MAX_BYTES = 20 * 1024 * 1024;

/** IMAGE_PICK_MAX_BYTES, as it should appear in a message to a person. */
export const IMAGE_PICK_MAX_LABEL = '20 MB';

/**
 * What the compressor aims to come in under -- deliberately below the 4 MB
 * wire ceiling, because multipart framing rides on top of the bytes and the
 * compressor stops as soon as it is under target rather than hitting it exactly.
 */
export const IMAGE_COMPRESS_TARGET_BYTES = Math.floor(3.5 * 1024 * 1024);

/** Longest edge kept when downscaling. Ample for a full-bleed background. */
export const IMAGE_COMPRESS_MAX_EDGE = 2560;

/** Extensions the compressor can decode, downscale and re-encode. */
export const COMPRESSIBLE_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** macOS metadata segments that must never be uploaded. */
export function isHiddenUploadSegment(seg: string): boolean {
  return seg.startsWith('.') || seg === '__MACOSX';
}
