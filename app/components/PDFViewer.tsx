'use client';

import { useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import type { ComponentProps } from 'react';

// Derived from react-pdf's own callback rather than imported from 'pdfjs-dist'.
// The repo resolves two different pdfjs-dist versions -- react-pdf pins a
// nested copy (5.x) while the top level is 6.x -- and their PDFDocumentProxy
// types are not assignable to each other. Taking the type from the component
// that hands us the value keeps it correct through either version bump.
type PDFDocumentProxy = Parameters<
  NonNullable<ComponentProps<typeof Document>['onLoadSuccess']>
>[0];
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Download, List, X } from 'lucide-react';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

// Served from public/ (kept in sync by `npm run pdf:worker`, which runs before
// dev and build) rather than a CDN: it is always the exact version react-pdf
// expects, and pdf.js ships the worker as .mjs -- the old cdnjs .js path 404s
// on v4+, which left every document stuck on "Loading PDF...".
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

// Served from public/ for the same reason as the worker above, and kept in
// sync by the same script. These were previously fetched from unpkg.com at
// render time, which put a third-party CDN on the critical path of every PDF:
// cmaps decode non-Latin and embedded-font text, so an unpkg outage degrades
// papers to missing glyphs rather than failing loudly, and a strict CSP blocks
// them outright.
//
// Defined at module scope, not inline: react-pdf re-runs document loading
// whenever the `options` prop is a new object reference, so an inline literal
// would reload the PDF on every render.
const pdfOptions = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
  disableAutoFetch: false,
  disableStream: false,
  isEvalSupported: false,
};

type Chapter = {
  title: string;
  page: number;
};

type PDFViewerProps = {
  fileUrl: string;
  fileName: string;
};

export default function PDFViewer({ fileUrl, fileName }: PDFViewerProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [showChapters, setShowChapters] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  function onDocumentLoadSuccess(pdf: PDFDocumentProxy) {
    setNumPages(pdf.numPages);
    // Detect chapters in background (non-blocking). The loaded document is
    // passed in rather than re-fetched: this callback already receives the
    // PDFDocumentProxy that <Document> downloaded, and calling
    // pdfjs.getDocument(fileUrl) again downloaded the whole file a second
    // time. With the S3 driver the bytes come from a presigned R2 URL served
    // `Cache-Control: private, no-store`, so the browser could not reuse the
    // first copy and every paper cost two full multi-megabyte downloads.
    //
    // The page count comes off the proxy for the same reason it was once
    // passed explicitly: `numPages` state is still 0 in this render, so the
    // text-scanning fallback would loop `Math.min(0, 50)` times and find
    // nothing.
    setTimeout(() => detectChapters(pdf), 100);
  }

  function onDocumentLoadError(error: Error) {
    console.error('Error loading PDF:', error);
    console.error('File URL:', fileUrl);
    setLoadError(error.message || 'Failed to load PDF file. The file may be corrupted or the URL has expired.');
  }

  const detectChapters = async (pdf: PDFDocumentProxy) => {
    try {
      const totalPages = pdf.numPages;
      const detectedChapters: Chapter[] = [];

      // Check PDF outline (table of contents)
      const outline = await pdf.getOutline();

      if (outline && outline.length > 0) {
        // Use PDF's built-in outline
        for (const item of outline) {
          if (item.dest) {
            try {
              // getDestination expects a string name. If dest is already an
              // explicit array (resolved destination), use it directly.
              let ref: string | null = null;
              if (typeof item.dest === 'string') ref = item.dest;
              const dest = ref ? await pdf.getDestination(ref) : (Array.isArray(item.dest) ? item.dest : null);
              if (dest) {
                const pageIndex = await pdf.getPageIndex(dest[0]);
                detectedChapters.push({
                  title: item.title,
                  page: pageIndex + 1,
                });
              }
            } catch (e) {
              console.error('Error getting destination:', e);
            }
          }
        }
      } else {
        // Fallback: Search for chapter patterns in text
        for (let i = 1; i <= Math.min(totalPages, 50); i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          // TextContent items are either TextItem (which has `str`) or
          // TextMarkedContent (which does not); narrow rather than cast.
          const text = textContent.items
            .map((item) => ('str' in item ? item.str : ''))
            .join(' ');

          // Look for common chapter patterns
          const chapterMatch = text.match(/(?:Chapter|CHAPTER)\s+(\d+)[:\s]+([^\n]+)/);
          if (chapterMatch) {
            detectedChapters.push({
              title: `Chapter ${chapterMatch[1]}: ${chapterMatch[2].trim().substring(0, 50)}`,
              page: i,
            });
          }
        }
      }

      setChapters(detectedChapters);
    } catch (error) {
      console.error('Error detecting chapters:', error);
    }
  };

  const goToPage = (page: number) => {
    setPageNumber(Math.max(1, Math.min(page, numPages)));
  };

  const zoomIn = () => setScale(prev => Math.min(prev + 0.2, 2.5));
  const zoomOut = () => setScale(prev => Math.max(prev - 0.2, 0.5));

  return (
    <div className="flex h-full">
      {/* Chapter Sidebar */}
      {showChapters && chapters.length > 0 && (
        <div className="w-64 border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 overflow-y-auto">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 flex items-center">
              <List className="w-4 h-4 mr-2" />
              Chapters
            </h3>
          </div>
          <div className="p-2">
            {chapters.map((chapter, idx) => (
              <button
                key={idx}
                onClick={() => goToPage(chapter.page)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                  pageNumber === chapter.page
                    ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 font-medium'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                <div className="flex items-start space-x-2">
                  <span className="text-xs text-gray-500 mt-0.5">{chapter.page}</span>
                  <span className="flex-1 line-clamp-2">{chapter.title}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* PDF Viewer */}
      <div className="flex-1 flex flex-col">
        {/* Toolbar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
          <div className="flex items-center space-x-2">
            {/* Page Navigation */}
            <button
              onClick={() => goToPage(pageNumber - 1)}
              disabled={pageNumber <= 1}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>

            <div className="flex items-center space-x-2">
              <input
                type="number"
                value={pageNumber}
                onChange={(e) => goToPage(parseInt(e.target.value) || 1)}
                className="w-16 px-2 py-1 text-center border border-gray-300 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 rounded text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                min={1}
                max={numPages}
              />
              <span className="text-sm text-gray-600 dark:text-gray-400">/ {numPages}</span>
            </div>

            <button
              onClick={() => goToPage(pageNumber + 1)}
              disabled={pageNumber >= numPages}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          <div className="flex items-center space-x-2">
            {/* Zoom Controls */}
            <button
              onClick={zoomOut}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title="Zoom out"
              aria-label="Zoom out"
            >
              <ZoomOut className="w-5 h-5" />
            </button>

            <span className="text-sm text-gray-600 dark:text-gray-400 w-12 text-center">
              {Math.round(scale * 100)}%
            </span>

            <button
              onClick={zoomIn}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title="Zoom in"
              aria-label="Zoom in"
            >
              <ZoomIn className="w-5 h-5" />
            </button>

            {/* Chapter Toggle */}
            {chapters.length > 0 && (
              <button
                onClick={() => setShowChapters(!showChapters)}
                className={`p-2 rounded-lg transition-colors ${
                  showChapters ? 'bg-indigo-100 dark:bg-indigo-900/40 text-green-600 dark:text-green-400' : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                }`}
                title="Toggle chapters"
                aria-label="Toggle chapter list"
              >
                <List className="w-5 h-5" />
              </button>
            )}

            {/* Download */}
            <a
              href={fileUrl}
              download={fileName}
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              title="Download PDF"
              aria-label="Download PDF"
            >
              <Download className="w-5 h-5" />
            </a>
          </div>
        </div>

        {/* PDF Content */}
        <div className="flex-1 overflow-auto bg-gray-200 dark:bg-gray-900 p-4">
          <div className="flex justify-center">
            {loadError && (
              <div className="flex items-center justify-center h-96">
                <div className="text-center max-w-md p-8 bg-red-50 rounded-lg border border-red-200">
                  <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <X className="w-8 h-8 text-red-600" />
                  </div>
                  <h3 className="text-lg font-semibold text-red-900 mb-2">
                    This PDF couldn&apos;t be opened
                  </h3>
                  {/* The old copy explained blob URL lifetimes and told the
                      reader to "re-upload the PDF" — advice a student cannot
                      act on for a past paper they did not upload. Give them the
                      two things they can actually do instead. */}
                  <p className="text-sm text-red-700 mb-4">
                    The file may still be uploading, or the link may have expired.
                    Reloading the page usually fixes it.
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => window.location.reload()}
                      className="inline-flex items-center space-x-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm"
                    >
                      <span>Reload the page</span>
                    </button>
                    <a
                      href={fileUrl}
                      download={fileName}
                      className="inline-flex items-center space-x-2 px-4 py-2 bg-white border border-red-300 text-red-700 rounded-lg hover:bg-red-50 transition-colors text-sm"
                    >
                      <Download className="w-4 h-4" />
                      <span>Download instead</span>
                    </a>
                  </div>
                  <p className="mt-4 text-xs text-red-500">
                    If it keeps failing, let your teacher know. ({loadError})
                  </p>
                </div>
              </div>
            )}

            {/* Document must always be mounted while there is no error: it is
                what triggers loading, and its own `loading` prop renders the
                spinner. Gating it on an isLoading flag that only clears in
                onLoadSuccess deadlocks -- the document never starts loading. */}
            {!loadError && (
              <Document
                file={fileUrl}
                onLoadSuccess={onDocumentLoadSuccess}
                onLoadError={onDocumentLoadError}
                className="shadow-lg"
                loading={
                  <div className="flex items-center justify-center h-96">
                    <div className="text-center">
                      <div className="w-12 h-12 border-4 border-green-600 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                      <p className="text-gray-600 dark:text-gray-400">Loading PDF...</p>
                    </div>
                  </div>
                }
                options={pdfOptions}
              >
                <Page
                  pageNumber={pageNumber}
                  scale={scale}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                  loading={
                    <div className="flex items-center justify-center h-96">
                      <div className="text-center">
                        <div className="w-8 h-8 border-4 border-green-600 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                        <p className="text-sm text-gray-600 dark:text-gray-400">Rendering page {pageNumber}...</p>
                      </div>
                    </div>
                  }
                />
              </Document>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
