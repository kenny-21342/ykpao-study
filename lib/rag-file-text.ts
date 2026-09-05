/**
 * Read the words out of an uploaded file, so the chat can answer from what a
 * document says rather than only from what it was named.
 *
 * Before this, a resource reached the index as `description + fileName`. A
 * teacher could upload a 40-page revision booklet and the only searchable text
 * was "Revision booklet" -- findable if a student already knew it existed,
 * useless otherwise.
 *
 * Extraction is best-effort by design. A scanned PDF has no text layer and
 * yields nothing; .docx and .pptx need parsers the app does not carry. Those
 * are not failures, and they must not block the upload -- the caller falls back
 * to title and description, which is exactly the old behaviour.
 */
// Relative, with extensions, like `lib/storage/*` itself: it keeps this module
// loadable by the bare-node test runner, which does not resolve the `@/` alias.
import { getStorage } from './storage/index.ts';
import { keyFromPublicPath } from './storage/keys.ts';

/**
 * Stop after this many pages. Bounds the work an upload request can trigger:
 * the whole point is a searchable summary, and a student's query matching page
 * 200 of a textbook is not the case worth paying for on every upload.
 */
const MAX_PAGES = 60;

/** Roughly 110 chunks at the indexer's 1,100-character chunk size. */
const MAX_CHARS = 120_000;

/**
 * Below this, treat the extraction as empty rather than partial. A scanned PDF
 * still yields a few stray characters from page furniture -- a header, a page
 * number -- and indexing that as though it were the document's contents is
 * worse than admitting there is no text layer.
 */
const MIN_USEFUL_CHARS = 40;

const TEXT_MIME = /^text\/|^application\/(json|xml|x-yaml|yaml)$/i;
const TEXT_EXTENSION = /\.(txt|md|markdown|csv|tsv|json|xml|ya?ml|rtf)$/i;

export type ExtractedFileText = {
  text: string;
  /** Why there is no text, for logging and for the resource's metadata. */
  reason: 'ok' | 'no-text-layer' | 'unsupported-type' | 'missing-file' | 'failed';
  pages?: number;
  truncated: boolean;
};

const NOTHING = (reason: ExtractedFileText['reason']): ExtractedFileText => ({
  text: '',
  reason,
  truncated: false,
});

async function extractPdfText(bytes: Buffer): Promise<ExtractedFileText> {
  // The legacy build is the one that runs outside a browser. Imported lazily so
  // that indexing a note never pays to load a PDF engine.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // A fresh Uint8Array: pdf.js takes ownership of the buffer it is handed and
  // detaches it, which would corrupt a Buffer the caller still holds.
  const data = new Uint8Array(bytes);
  const task = pdfjs.getDocument({ data, useSystemFonts: false });
  try {
    const doc = await task.promise;
    const pageCount = Math.min(doc.numPages, MAX_PAGES);
    const parts: string[] = [];
    let length = 0;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const content = await (await doc.getPage(pageNumber)).getTextContent();
      const pageText = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ');
      parts.push(pageText);
      length += pageText.length;
      if (length >= MAX_CHARS) break;
    }
    const text = parts.join('\n').slice(0, MAX_CHARS);
    if (text.trim().length < MIN_USEFUL_CHARS) return NOTHING('no-text-layer');
    return {
      text,
      reason: 'ok',
      pages: doc.numPages,
      truncated: doc.numPages > pageCount || length >= MAX_CHARS,
    };
  } finally {
    // Releases the worker port whether or not a page threw.
    await task.destroy();
  }
}

/**
 * The text of the file behind a resource's public `/uploads/...` path.
 *
 * Never throws: every failure is a reason code, because an upload that
 * succeeded must not be rolled back by an indexing problem.
 */
export async function extractFileText(
  fileUrl: string,
  mimeType: string | null | undefined,
  fileName: string | null | undefined,
): Promise<ExtractedFileText> {
  const key = keyFromPublicPath(fileUrl);
  if (!key) return NOTHING('unsupported-type');

  const mime = (mimeType ?? '').toLowerCase();
  const name = fileName ?? '';
  const isPdf = mime.includes('pdf') || /\.pdf$/i.test(name);
  const isText = TEXT_MIME.test(mime) || TEXT_EXTENSION.test(name);
  if (!isPdf && !isText) return NOTHING('unsupported-type');

  try {
    const object = await getStorage().get(key);
    if (!object) return NOTHING('missing-file');

    if (isPdf) return await extractPdfText(object.bytes);

    const text = object.bytes.toString('utf8').slice(0, MAX_CHARS);
    if (text.trim().length < MIN_USEFUL_CHARS) return NOTHING('no-text-layer');
    return { text, reason: 'ok', truncated: object.bytes.length > MAX_CHARS };
  } catch (error) {
    console.warn(
      'RAG file extraction failed for %s: %s',
      fileUrl,
      error instanceof Error ? error.message : error,
    );
    return NOTHING('failed');
  }
}
