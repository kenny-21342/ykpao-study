import { getStorage, paperKey } from './storage/index.ts';

/**
 * Locating past paper PDFs.
 *
 * Stored paths are relative to `pdf_extraction/` (e.g.
 * `my_raw_pdfs/igcse/physics-0625/0625_w21_qp_63.pdf`). Older rows kept a
 * leading `pdf_extraction/`, so that prefix is tolerated too.
 *
 * The bytes themselves live in the object store (`lib/storage/`), which is the
 * filesystem in development and an S3-compatible bucket in production. Every
 * path from the database is untrusted as far as storage is concerned, so
 * `paperKey()` confines it to the papers prefix before it reaches a driver.
 */

export { paperKey } from './storage/index.ts';

export type PaperFile = {
  bytes: Buffer;
  size: number;
};

/**
 * Read a stored PDF, verifying it is really a PDF before it is served.
 * Returns null when the path is invalid, missing, or not a PDF.
 *
 * Prefer `paperDownloadUrl()` where the caller can redirect: buffering a whole
 * PDF through a serverless function costs memory and runs into Vercel's ~4.5 MB
 * response cap, which plenty of these papers exceed.
 */
export async function readPaperPdf(storedPath: string): Promise<PaperFile | null> {
  const key = paperKey(storedPath);
  if (!key) return null;

  try {
    const object = await getStorage().get(key);
    if (!object) return null;

    const { bytes } = object;
    if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return null;
    }
    return { bytes, size: object.size };
  } catch (error) {
    console.error('[paper-files] failed to read %s:', key, error);
    return null;
  }
}

/**
 * A short-lived URL the browser can fetch the PDF from directly.
 *
 * Returns null when the store cannot issue one (the local driver) or the key is
 * invalid — the caller then falls back to streaming via `readPaperPdf`.
 *
 * Note that this path does *not* verify the `%PDF-` magic bytes, because
 * nothing is read server-side. That check happens when objects are uploaded
 * and during `npm run storage:sync`.
 */
export async function paperDownloadUrl(
  storedPath: string,
  options: { filename: string; download: boolean }
): Promise<string | null> {
  const key = paperKey(storedPath);
  if (!key) return null;

  try {
    return await getStorage().signedGetUrl(key, {
      contentType: 'application/pdf',
      contentDisposition: contentDisposition(options.filename, options.download),
    });
  } catch (error) {
    console.error('[paper-files] failed to sign a URL for %s:', key, error);
    return null;
  }
}

/** Build a Content-Disposition value safe for an arbitrary stored filename. */
export function contentDisposition(filename: string, download: boolean): string {
  const fallback = filename.replace(/["\\]/g, '').replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(filename);
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
