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
import { commandTerm } from '@/lib/command-terms';
import QuestionScratchpadPanel from './QuestionScratchpadPanel';

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
        className="sticky top-2 left-full z-10 mr-2 rounded-full bg-surface/90 p-2 text-primary shadow-overlay"
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
    attemptId: string | null;
    isCorrect: boolean | null;
    correctLetter: string | null;
    awardedMarks: number | null;
    outOfMarks: number | null;
  } | null>(null);
  const [marking, setMarking] = useState(false);

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
        attemptId: data.attempt?.id ?? null,
        isCorrect: data.attempt?.isCorrect ?? null,
        correctLetter: data.correctLetter ?? null,
        awardedMarks: data.attempt?.awardedMarks ?? null,
        outOfMarks: data.attempt?.outOfMarks ?? null,
      });
      onAnswered();
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Send the mark the student gave themselves.
   *
   * A PATCH onto the attempt they already saved, not a new one: the answer is
   * written before the mark scheme is revealed and the mark comes after reading
   * it, and recording that as a second attempt would double every
   * free-response question in their history.
   */
  const selfMark = async (payload: { awardedMarks?: number; selfMarkedCorrect?: boolean }) => {
    if (!result?.attemptId || marking) return;
    setMarking(true);
    setError(null);
    try {
      const res = await fetch('/api/bank/attempts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attemptId: result.attemptId, ...payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not save your mark');
      setResult({
        ...result,
        isCorrect: data.attempt?.isCorrect ?? null,
        awardedMarks: data.attempt?.awardedMarks ?? null,
        outOfMarks: data.attempt?.outOfMarks ?? null,
      });
    } catch (markError) {
      setError((markError as Error).message);
    } finally {
      setMarking(false);
    }
  };

  if (result) {
    const { isCorrect, correctLetter, awardedMarks, outOfMarks } = result;
    const total = question.totalMarks;
    // Only where the corpus captured a mark total -- most of the bank has none,
    // because a total is only recorded where the paper printed one. Inventing
    // one to render a stepper would be worse than the true/false it replaces.
    const canAwardMarks = isCorrect === null && total !== null && total > 1;
    return (
      <div className="border-t border-subtle px-4 py-3">
        {isCorrect === true && (
          <p className="text-sm font-medium text-accent-text">Correct.</p>
        )}
        {/* Suppressed once marks are on the screen: "Not quite" is the wrong
          * word for 5 out of 6, and the marks say it better. */}
        {isCorrect === false && awardedMarks === null && (
          <p className="text-sm font-medium text-danger">
            Not quite.
            {correctLetter && (
              <>
                {' '}
                The answer is <span className="font-semibold">{correctLetter}</span>.
              </>
            )}
          </p>
        )}
        {isCorrect === null && !canAwardMarks && (
          <div className="space-y-2">
            <p className="text-sm text-secondary">
              Answer saved. Check it against the mark scheme below, then mark it.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={marking}
                onClick={() => selfMark({ selfMarkedCorrect: true })}
                className="rounded-md border border-accent px-3 py-1.5 text-sm font-medium text-accent-text hover:bg-accent-subtle disabled:opacity-50"
              >
                I got it right
              </button>
              <button
                type="button"
                disabled={marking}
                onClick={() => selfMark({ selfMarkedCorrect: false })}
                className="rounded-md border border-strong px-3 py-1.5 text-sm font-medium text-secondary hover:bg-surface-hover disabled:opacity-50"
              >
                I got it wrong
              </button>
            </div>
          </div>
        )}
        {canAwardMarks && (
          <div className="space-y-2">
            <p className="text-sm text-secondary">
              Answer saved. Read the mark scheme below, then award yourself the marks
              you would have earned.
            </p>
            {/* Every mark, not right/wrong. On a question worth 12 a verdict
              * throws away almost everything marking it taught you. */}
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Marks awarded">
              {Array.from({ length: total + 1 }, (_, mark) => (
                <button
                  key={mark}
                  type="button"
                  disabled={marking}
                  onClick={() => selfMark({ awardedMarks: mark })}
                  className="h-9 min-w-9 rounded-md border border-strong px-2 text-sm font-semibold tabular-nums text-secondary hover:border-accent hover:bg-accent-subtle disabled:opacity-50"
                >
                  {mark}
                </button>
              ))}
              <span className="self-center pl-1 text-xs text-muted">
                out of {total}
              </span>
            </div>
          </div>
        )}
        {awardedMarks !== null && outOfMarks !== null && (
          <p className="text-sm font-medium text-primary">
            You awarded yourself {awardedMarks} of {outOfMarks} marks.
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setAnswer('');
          }}
          className="mt-2 text-xs text-accent-text underline hover:no-underline"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-subtle px-4 py-3">
      {answerLetter ? (
        <div className="flex flex-wrap gap-2">
          {optionLettersFor(answerLetter).map((letter) => (
            <button
              key={letter}
              type="button"
              disabled={saving}
              onClick={() => submit(letter)}
              className="h-10 w-10 rounded-md border border-strong text-sm font-semibold text-secondary hover:border-accent hover:bg-accent-subtle disabled:opacity-50"
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
            className="w-full rounded-md border border-strong px-3 py-2 text-sm bg-surface text-primary"
          />
          <QuestionScratchpadPanel questionRef={{ bankQuestionId: question.id }} />
          <button
            type="button"
            disabled={saving || !answer.trim()}
            onClick={() => submit(answer)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save answer'}
          </button>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}

/**
 * What the question is asking you to *do*.
 *
 * Marks are awarded against the command term, not against how much you know:
 * "describe" pays for detail and nothing for reasons, "explain" pays for
 * reasons and little for detail, and a student who has revised thoroughly can
 * still score half on a question by answering the wrong verb. That is invisible
 * on the paper, so it is surfaced here -- before the answer box, not after the
 * mark scheme, because the point is to change the answer being written.
 *
 * Collapsed by default: the terms alone are the reminder, and a student who
 * knows what "evaluate" wants should not have to scroll past a paragraph
 * telling them.
 */
function CommandTermPanel({ slugs }: { slugs: string[] }) {
  const [open, setOpen] = useState(false);
  const terms = slugs.map(commandTerm).filter((term) => term !== null);
  if (!terms.length) return null;

  return (
    <div className="border-t border-subtle px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Asks you to</span>
        {terms.map((term) => (
          <span
            key={term.slug}
            className="rounded-full bg-surface-raised px-2 py-0.5 text-xs font-medium text-secondary"
          >
            {term.label}
          </span>
        ))}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="ml-auto text-xs text-muted underline-offset-2 hover:underline"
        >
          {open ? 'Hide' : 'What earns the marks?'}
        </button>
      </div>
      {open && (
        <ul className="mt-2 space-y-1.5">
          {terms.map((term) => (
            <li key={term.slug} className="text-xs text-secondary">
              <span className="font-semibold text-primary">{term.label}:</span>{' '}
              {term.guidance}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function BankQuestionCard({
  question,
  onAttempted,
}: {
  question: Question;
  /** Called once an answer has been saved, so the list can mark the row done. */
  onAttempted?: () => void;
}) {
  const [showAnswer, setShowAnswer] = useState(false);
  const [zoomed, setZoomed] = useState<'question' | 'markScheme' | null>(null);

  return (
    <article className="rounded-lg border border-line bg-surface">
      <header className="flex items-baseline justify-between gap-3 border-b border-subtle px-4 py-3">
        {/* The question's own number is the title of this card, so it is set
            like one. At text-sm it was the same size as the mark count beside
            it and read as another label. */}
        <h2 className="text-base font-semibold text-primary">
          Question {question.rootNumber}
        </h2>
        <div className="flex items-center gap-3 text-xs text-muted">
          {/* The extractor stores 0 for a multiple-choice question it could not
              read a mark total from; "0 marks" is wrong, and the list already
              hides it. A question with a single answer letter is worth one. */}
          {question.totalMarks !== null && question.totalMarks > 0 ? (
            <span>{question.totalMarks === 1 ? '1 mark' : `${question.totalMarks} marks`}</span>
          ) : question.markScheme?.answerLetter ? (
            <span>1 mark</span>
          ) : null}
          <button
            type="button"
            onClick={() => setZoomed('question')}
            // A crop is ~1420px of A4 column. Fitted to a 390px phone that puts
            // 11pt body text at roughly 8.5 CSS px: sharp, but too small to
            // work from for long, so full size has to be one tap away.
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-surface-hover hover:text-secondary"
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

      <CommandTermPanel slugs={question.commandTerms} />

      <AnswerPanel
        question={question}
        onAnswered={() => {
          setShowAnswer(true);
          onAttempted?.();
        }}
      />

      {question.markScheme &&
        (question.markScheme.strips.length > 0 || question.markScheme.answerLetter) && (
        <div className="border-t border-subtle">
          <button
            type="button"
            onClick={() => setShowAnswer((open) => !open)}
            aria-expanded={showAnswer}
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-secondary hover:bg-surface-hover"
          >
            {showAnswer ? 'Hide mark scheme' : 'Show mark scheme'}
            {showAnswer ? (
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
          {showAnswer && (
            <div className="border-t border-subtle bg-surface-raised p-2 sm:p-4">
              {question.markScheme.strips.length > 0 ? (
                <StripStack
                  strips={question.markScheme.strips}
                  alt={`Mark scheme for question ${question.rootNumber}`}
                  onZoom={() => setZoomed('markScheme')}
                />
              ) : (
                // A multiple-choice key is a letter, not an image.
                <p className="text-sm text-secondary">
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
        <div className="border-t border-subtle px-4 py-3">
          <p className="text-sm text-muted">
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
