/**
 * Client-side reading of an /api/upload response.
 *
 * Every caller used to do this by hand:
 *
 *   const data = await res.json();
 *   if (!res.ok || !data.fileUrl) throw new Error(data.error || 'Upload failed');
 *
 * which is correct only while the response is JSON. It is not always JSON: an
 * upload over the platform's request-body ceiling is rejected at the edge
 * before the route runs, and that rejection is `text/plain` reading "Request
 * Entity Too Large". `res.json()` then throws its own parse error, so what
 * reached the student was
 *
 *   Unexpected token 'R', "Request En"... is not valid JSON
 *
 * -- the JSON parser's complaint, not a description of what went wrong. The
 * real failure (their file is too big) was never stated anywhere.
 *
 * So: read the body once as text, and only then try to interpret it.
 */

import { RESOURCE_UPLOAD_MAX_LABEL } from './upload-constants.ts';

export type UploadResult = {
  fileUrl: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  resourceFolderId?: string | null;
};

/**
 * Turn an upload response into either a result or a readable Error.
 *
 * Never throws a parse error: a body that is not JSON is reported by what the
 * status code means, which is the part the person can act on.
 */
export async function readUploadResult(res: Response): Promise<UploadResult> {
  const raw = await res.text().catch(() => '');

  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // Not JSON. Deliberately fall through -- `parsed` stays null and the
    // status code below decides the message.
  }

  const asRecord = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  const serverError = typeof asRecord?.error === 'string' ? asRecord.error : null;

  if (!res.ok || !asRecord || typeof asRecord.fileUrl !== 'string') {
    throw new Error(serverError ?? uploadFailureMessage(res.status));
  }

  return {
    fileUrl: asRecord.fileUrl,
    fileName: typeof asRecord.fileName === 'string' ? asRecord.fileName : 'file',
    fileSize: typeof asRecord.fileSize === 'number' ? asRecord.fileSize : 0,
    mimeType: typeof asRecord.mimeType === 'string' ? asRecord.mimeType : 'application/octet-stream',
    resourceFolderId: typeof asRecord.resourceFolderId === 'string' ? asRecord.resourceFolderId : null,
  };
}

/**
 * What to tell someone when the response carried no usable JSON error of its
 * own. Only 413 is really expected here -- it is the one the platform answers
 * itself, in plain text, without consulting the route.
 */
export function uploadFailureMessage(status: number): string {
  if (status === 413) {
    return `That file is too large to upload (max ${RESOURCE_UPLOAD_MAX_LABEL}).`;
  }
  if (status === 401) return 'Your session has expired. Sign in again to upload.';
  if (status === 403) return 'You do not have permission to upload here.';
  if (status === 429) return 'Too many uploads just now. Wait a moment and try again.';
  if (status >= 500) return 'The server could not store that file. Try again.';
  return 'Upload failed.';
}
