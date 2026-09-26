/** URL shapes issued by /api/upload for school resources. */
const RESOURCE_UPLOAD_URL = /^\/uploads\/(?:images|files)\/(?:resources\/([a-z0-9]+)\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,10}$/i;

export function resourceUploadFolderId(fileUrl: string): string | null | undefined {
  const match = RESOURCE_UPLOAD_URL.exec(fileUrl);
  return match ? (match[1] ?? null) : undefined;
}
