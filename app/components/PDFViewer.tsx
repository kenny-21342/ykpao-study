'use client';

import { Download } from 'lucide-react';

type PDFViewerProps = {
  fileUrl: string;
  fileName: string;
};

// Renders via the browser's own PDF viewer instead of a custom react-pdf
// component: the previous viewer had renderTextLayer/renderAnnotationLayer
// both disabled (no in-app text search/select), no crop/annotation features
// of its own, and its chapter-outline sidebar duplicated what Chrome/Edge/
// Firefox already show from a PDF's real embedded bookmarks. `<object>` is
// used (not a bare `<iframe>`) because it degrades to its own children when
// a browser can't render the `data` resource inline, so the download-instead
// fallback below only kicks in for that case.
//
// The height is set here, in viewport units, rather than inherited. `<object>`
// is a replaced element: with no definite height to fill it falls back to the
// HTML default of 150px, and every caller so far has mounted this inside an
// auto-height container -- so `h-full` resolved to nothing and the paper
// rendered as a blank 150px sliver.
export default function PDFViewer({ fileUrl, fileName }: PDFViewerProps) {
  return (
    <div className="flex h-[calc(100vh-15rem)] min-h-[520px] flex-col">
      <div className="flex items-center justify-end border-b border-gray-200 bg-white px-4 py-2 dark:border-gray-700 dark:bg-gray-800">
        <a
          href={`${fileUrl}${fileUrl.includes('?') ? '&' : '?'}download=1`}
          download={fileName}
          className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-gray-600 transition-colors hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
          title="Download PDF" aria-label="Download PDF"
        >
          <Download className="h-4 w-4" />
          Download
        </a>
      </div>
      <object data={fileUrl} type="application/pdf" className="h-full w-full flex-1" aria-label={fileName}>
        {/* Reached only when the browser can't render `data` inline (some
            mobile browsers, or a PDF plugin that's been disabled). */}
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-gray-100 p-8 text-center dark:bg-gray-900">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Your browser can&apos;t preview this PDF inline.
          </p>
          <a
            href={`${fileUrl}${fileUrl.includes('?') ? '&' : '?'}download=1`}
            download={fileName}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white transition-colors hover:bg-emerald-700"
          >
            <Download className="h-4 w-4" />
            Download instead
          </a>
        </div>
      </object>
    </div>
  );
}
