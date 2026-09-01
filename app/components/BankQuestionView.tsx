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
import { optionLettersFor } from '@/lib/bank-grading';

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
            // As in the other strip renderers: a transparent crop must not
            // vanish into the dark theme, so the ground is on the image.
            className="block h-auto paper-ground"
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
      <div className="w-max paper-ground">
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

/**
 * Where a student answers the question.
 *
 * Two shapes, decided by whether the mark scheme carries an answer key. A keyed
 * question gets option buttons, because it *is* a multiple-choice question and
 * a free-text box asking for one of four letters is a worse version of four
 * buttons. Everything else gets a textarea and marks itself against the mark
 * scheme, which is the only honest option while the question has no transcript
 * for the model to mark against.
 *
 * Either way the mark scheme opens as soon as an answer is in. Withholding it
 * after the attempt is what made the daily challenge useless -- a verdict with
 * nothing to learn from is not feedback.
 */
function AnswerPanel({
  question,
  onAnswered,
}: {
  question: Question;
  onAnswered: () => void;
}) {
  const answerLetter = question.markScheme?.answerLetter ?? null;
  const [answer, setAnswer] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    isCorrect: boolean | null;
    correctLetter: string | null;
  } | null>(null);

  const submit = async (value: string) => {
    if (!value.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/bank/attempts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: question.id, answer: value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not save your answer');
      setResult({
        isCorrect: data.attempt?.isCorrect ?? null,
        correctLetter: data.correctLetter ?? null,
      });
      onAnswered();
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (result) {
    const { isCorrect, correctLetter } = result;
    return (
      <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-700">
        {isCorrect === true && (
          <p className="text-sm font-medium text-green-700 dark:text-green-400">Correct.</p>
        )}
        {isCorrect === false && (
          <p className="text-sm font-medium text-red-700 dark:text-red-400">
            Not quite.
            {correctLetter && (
              <>
                {' '}
                The answer is <span className="font-semibold">{correctLetter}</span>.
              </>
            )}
          </p>
        )}
        {isCorrect === null && (
          <p className="text-sm text-gray-700 dark:text-gray-200">
            Answer saved. Check it against the mark scheme below.
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setAnswer('');
          }}
          className="mt-2 text-xs text-green-700 underline hover:no-underline dark:text-green-400"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-700">
      {answerLetter ? (
        <div className="flex flex-wrap gap-2">
          {optionLettersFor(answerLetter).map((letter) => (
            <button
              key={letter}
              type="button"
              disabled={saving}
              onClick={() => submit(letter)}
              className="h-10 w-10 rounded-md border border-gray-300 text-sm font-semibold text-gray-700 hover:border-green-500 hover:bg-green-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:border-green-500 dark:hover:bg-green-900/30"
            >
              {letter}
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            rows={3}
            placeholder="Write your working, then mark it against the mark scheme."
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
          <button
            type="button"
            disabled={saving || !answer.trim()}
            onClick={() => submit(answer)}
            className="rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save answer'}
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
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

      <AnswerPanel question={question} onAnswered={() => setShowAnswer(true)} />

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

      {/*
        A quarter of the published bank -- 16,749 of 66,756 questions -- has no
        mark scheme behind it, because the paper's scheme has not been matched
        and published yet. Saying nothing leaves a student who has just worked
        through the question hunting for a reveal control that was never
        rendered. The list badges which questions have one; this is the same
        fact stated where they actually need it.
      */}
      {!(
        question.markScheme &&
        (question.markScheme.strips.length > 0 || question.markScheme.answerLetter)
      ) && (
        <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-700">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No mark scheme for this question yet. The question paper is complete
            &mdash; it is the matching scheme that is still being processed.
          </p>
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
