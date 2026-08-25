'use client';

/*
 * next/image is deliberately not used here.
 *
 * These are session-gated crops served from /bank_assets/**, which the image
 * optimiser would fetch server-side without the viewer's cookie and get a 401
 * for. They are also already rendered at a fixed 200 DPI, so re-encoding buys
 * nothing, and the zoom overlay wants exactly the natural size next/image
 * exists to avoid serving.
 */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Maximize2, X } from 'lucide-react';
import type { BankQuestionView as Question, BankStrip } from '@/lib/bank-questions';

/**
 * One past-paper question, shown as the crop it was cut from.
 *
 * The strips are the original page with the answer space and page furniture
 * removed, so they stack into a continuous question. They are *not* all the
 * same width — a narrow part renders narrow — so each is scaled against the
 * widest in the set rather than stretched to fill, which would leave one part
 * of a question visibly larger than the next.
 */
function StripStack({
  strips,
  alt,
  onZoom,
}: {
  strips: BankStrip[];
  alt: string;
  onZoom: () => void;
}) {
  const widest = Math.max(...strips.map((strip) => strip.width ?? 0), 1);

  return (
    // Wide crops scroll inside their own box; the page never scrolls sideways.
    // The zoom control lives in the card header rather than wrapping these
    // images: a button containing several thousand pixels of content reads
    // badly to a screen reader, and collapsed its contents in the browser.
    <div className="overflow-x-auto">
      <div
        className="mx-auto cursor-zoom-in"
        style={{ maxWidth: `${widest}px` }}
        onClick={onZoom}
      >
        {strips.map((strip, index) => (
          <img
            key={`${strip.url}-${index}`}
            src={strip.url}
            alt={index === 0 ? alt : ''}
            width={strip.width ?? undefined}
            height={strip.height ?? undefined}
            loading="lazy"
            decoding="async"
            className="block h-auto"
            style={{
              // Percentage of the widest strip, so a half-width part stays
              // half-width instead of being blown up to match.
              width: strip.width ? `${(strip.width / widest) * 100}%` : '100%',
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The crop at its natural size, pannable in both directions.
 *
 * Deliberately not a pinch-zoom container: the strips are already rendered at
 * 200 DPI, so natural size is legible on every phone and anything beyond it is
 * just bigger pixels.
 */
function ZoomOverlay({
  strips,
  alt,
  onClose,
}: {
  strips: BankStrip[];
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // The overlay scrolls; the page behind it must not.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-50 overflow-auto bg-black/90 p-2"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="sticky top-2 left-full z-10 mr-2 rounded-full bg-white/90 p-2 text-gray-900 shadow-lg"
        aria-label="Close"
      >
        <X className="h-5 w-5" aria-hidden="true" />
      </button>
      <div className="w-max bg-white">
        {strips.map((strip, index) => (
          <img
            key={`${strip.url}-${index}`}
            src={strip.url}
            alt={index === 0 ? alt : ''}
            width={strip.width ?? undefined}
            height={strip.height ?? undefined}
            className="block"
          />
        ))}
      </div>
    </div>
  );
}

export default function BankQuestionCard({ question }: { question: Question }) {
  const [showAnswer, setShowAnswer] = useState(false);
  const [zoomed, setZoomed] = useState<'question' | 'markScheme' | null>(null);

  return (
    <article className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <header className="flex items-baseline justify-between gap-3 border-b border-gray-100 px-4 py-3 dark:border-gray-700">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
          Question {question.rootNumber}
        </h2>
        <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
          {question.totalMarks !== null && <span>{question.totalMarks} marks</span>}
          <button
            type="button"
            onClick={() => setZoomed('question')}
            // A crop is ~1420px of A4 column. Fitted to a 390px phone that puts
            // 11pt body text at roughly 8.5 CSS px: sharp, but too small to
            // work from for long, so full size has to be one tap away.
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
            Enlarge
          </button>
          {question.pageStart !== null && (
            <span className="tabular-nums">
              {question.pageEnd && question.pageEnd !== question.pageStart
                ? `pages ${question.pageStart}–${question.pageEnd}`
                : `page ${question.pageStart}`}
            </span>
          )}
        </div>
      </header>

      <div className="p-2 sm:p-4">
        <StripStack
          strips={question.strips}
          alt={`Question ${question.rootNumber} from the original paper`}
          onZoom={() => setZoomed('question')}
        />
      </div>

      {question.markScheme &&
        (question.markScheme.strips.length > 0 || question.markScheme.answerLetter) && (
        <div className="border-t border-gray-100 dark:border-gray-700">
          <button
            type="button"
            onClick={() => setShowAnswer((open) => !open)}
            aria-expanded={showAnswer}
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700/50"
          >
            {showAnswer ? 'Hide mark scheme' : 'Show mark scheme'}
            {showAnswer ? (
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
          {showAnswer && (
            <div className="border-t border-gray-100 bg-gray-50 p-2 dark:border-gray-700 dark:bg-gray-900/40 sm:p-4">
              {question.markScheme.strips.length > 0 ? (
                <StripStack
                  strips={question.markScheme.strips}
                  alt={`Mark scheme for question ${question.rootNumber}`}
                  onZoom={() => setZoomed('markScheme')}
                />
              ) : (
                // A multiple-choice key is a letter, not an image.
                <p className="text-sm text-gray-700 dark:text-gray-200">
                  Answer:{' '}
                  <span className="font-semibold">{question.markScheme.answerLetter}</span>
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {zoomed && (
        <ZoomOverlay
          strips={zoomed === 'question' ? question.strips : question.markScheme!.strips}
          alt={
            zoomed === 'question'
              ? `Question ${question.rootNumber} from the original paper`
              : `Mark scheme for question ${question.rootNumber}`
          }
          onClose={() => setZoomed(null)}
        />
      )}
    </article>
  );
}
