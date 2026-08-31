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

/** Per-file ceiling enforced by /api/upload. */
export const RESOURCE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** Marker prepended to descriptions by folder uploads, preserving the path. */
export const FOLDER_UPLOAD_PREFIX = 'From folder upload: ';

/** macOS metadata segments that must never be uploaded. */
export function isHiddenUploadSegment(seg: string): boolean {
  return seg.startsWith('.') || seg === '__MACOSX';
}
