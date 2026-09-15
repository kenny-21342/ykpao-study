'use client';

import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Skeleton, SkeletonRegion } from './Skeleton';

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
  /**
   * Past papers are multi-megabyte scans, and until one arrives the `<object>`
   * paints nothing at all -- so the whole panel was a blank 520px rectangle
   * for however long the download took, with no way to tell a slow file from
   * a broken one. The placeholder below is a page-shaped skeleton, and after
   * a few seconds it says so in words.
   */
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);

  // `<object>` fires load inconsistently across browsers for PDFs -- and not
  // at all when the plugin is disabled and the fallback children render
  // instead. So the placeholder also clears on a timer: a stuck skeleton over
  // a paper that has actually rendered is worse than clearing early over one
  // that has not.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => {
    timers.current = [
      setTimeout(() => setSlow(true), 4000),
      setTimeout(() => setLoaded(true), 15000),
    ];
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, [fileUrl]);

  return (
    <div className="relative flex h-[calc(100vh-15rem)] min-h-[520px] flex-col">
      <div className="flex items-center justify-end border-b border-line bg-surface px-4 py-2">
        <a
          href={`${fileUrl}${fileUrl.includes('?') ? '&' : '?'}download=1`}
          download={fileName}
          className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-secondary transition-colors hover:bg-surface-hover"
          title="Download PDF" aria-label="Download PDF"
        >
          <Download className="h-4 w-4" />
          Download
        </a>
      </div>
      {!loaded && (
        <SkeletonRegion
          label="Loading the paper"
          className="pointer-events-none absolute inset-x-0 bottom-0 top-[41px] z-10 flex flex-col items-center gap-3 overflow-hidden bg-surface-raised p-6"
        >
          {/* Page-shaped, so the wait looks like a document arriving rather
              than an error. */}
          <div className="w-full max-w-2xl space-y-3 rounded-md bg-surface p-8">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          {slow && (
            <p className="text-sm text-secondary">
              Still downloading this paper — scans can be a few megabytes.
            </p>
          )}
        </SkeletonRegion>
      )}

      <object
        data={fileUrl}
        type="application/pdf"
        className="h-full w-full flex-1"
        aria-label={fileName}
        onLoad={() => setLoaded(true)}
      >
        {/* Reached only when the browser can't render `data` inline (some
            mobile browsers, or a PDF plugin that's been disabled). */}
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface-raised p-8 text-center">
          <p className="text-sm text-secondary">
            Your browser can&apos;t preview this PDF inline.
          </p>
          <a
            href={`${fileUrl}${fileUrl.includes('?') ? '&' : '?'}download=1`}
            download={fileName}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm text-white transition-colors hover:bg-accent-hover"
          >
            <Download className="h-4 w-4" />
            Download instead
          </a>
        </div>
      </object>
    </div>
  );
}
