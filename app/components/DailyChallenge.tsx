'use client';

/*
 * next/image is deliberately not used for the crops below: they are
 * session-gated strips from /bank_assets/**, which the optimiser would fetch
 * server-side without the viewer's cookie and get a 401 for.
 */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from 'react';
import { CalendarCheck, CheckCircle2, Loader2, Lock, Sparkles, Trophy, Users } from 'lucide-react';
import AiNotice from './AiNotice';
import FormattedMessage from './FormattedMessage';

type Strip = { url: string; width: number | null; height: number | null };

type ChallengeQuestion = {
  id: number;
  number: number;
  part: string | null;
  /** Empty for a crop-only bank question; `strips` carries it instead. */
  content: string;
  strips?: Strip[];
  marks: number;
  /** Non-null for multiple choice, so the UI can offer buttons not a textbox. */
  options: string[] | null;
  topic: string | null;
  paper: { year: number; subject: string };
};

type ChallengeData = {
  dateKey: string;
  question: ChallengeQuestion;
  attempt: {
    answer: string;
    score: number | null;
    isCorrect: boolean | null;
    attemptedAt: string;
    /** Returned only once an attempt exists, so it cannot be read early. */
    correctAnswer: string | null;
    markSchemeMd: string | null;
    markSchemeStrips: Strip[];
  } | null;
  stats: { participants: number; correctToday: number };
};

/** A question or mark scheme, whether it is stored as text or as a crop. */
function ChallengeContent({
  content,
  strips,
  alt,
}: {
  content: string | null;
  strips?: Strip[];
  alt: string;
}) {
  if (strips && strips.length > 0) {
    return (
      <div className="overflow-x-auto">
        {strips.map((strip, index) => (
          <img
            key={`${strip.url}-${index}`}
            src={strip.url}
            alt={index === 0 ? alt : ''}
            width={strip.width ?? undefined}
            height={strip.height ?? undefined}
            // The crops are scanned paper. Many are transparent PNGs with
            // black ink, which is invisible on the dark theme, so the white
            // ground travels with the image rather than the container.
            className="block max-w-full paper-ground"
          />
        ))}
      </div>
    );
  }
  if (!content) return null;
  return <FormattedMessage content={content} />;
}

export default function DailyChallenge() {
  const [data, setData] = useState<ChallengeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  // Returned by POST whenever an answer was recorded but not marked -- no
  // credentials, no transcript, or the grader was unreachable. It was being
  // dropped on the floor, so an unscored attempt looked like a silent failure.
  const [notice, setNotice] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/daily-challenge');
      if (res.ok) setData(await res.json());
    } catch {
      // best effort
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const submit = async (value?: string) => {
    const submitted = (value ?? answer).trim();
    if (!submitted || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/daily-challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: submitted }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? 'Submission failed');
      } else {
        setFeedback(json?.feedback ?? '');
        setNotice(json?.aiNotice ?? '');
        await load();
      }
    } catch {
      // Without this, a dropped connection rejected the promise, skipped the
      // error branch entirely, and left the student looking at an unchanged
      // form with no idea their answer never arrived.
      setError('Could not reach the server. Your answer was not submitted — check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="rounded-lg border border-line bg-surface p-4">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading daily challenge…</span>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const completed = Boolean(data.attempt);

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-subtle text-accent-text">
            <CalendarCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-primary">Daily challenge</h3>
            <p className="truncate text-[11px] text-muted">
              {data.question.paper.subject}
              {data.question.topic ? ` · ${data.question.topic}` : ''}
            </p>
          </div>
        </div>
        {completed && (
          <span className="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-2 py-1 text-[10px] font-semibold text-accent-text">
            <CheckCircle2 className="h-3 w-3" />
            Done
          </span>
        )}
      </div>

      <div className="mt-3 rounded-md border border-line bg-surface-raised p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-muted">
            Q{data.question.number}
            {data.question.part ? `${data.question.part}` : ''} · {data.question.paper.year}
          </span>
          <span className="text-[11px] font-semibold text-accent-text">
            {data.question.marks} {data.question.marks === 1 ? 'mark' : 'marks'}
          </span>
        </div>
        <div className="mt-2 text-sm text-primary">
          <ChallengeContent
            content={data.question.content}
            strips={data.question.strips}
            alt={`Question ${data.question.number}`}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1">
          <Users className="h-3.5 w-3.5" />
          {data.stats.participants} today
        </span>
        <span className="inline-flex items-center gap-1">
          <Trophy className="h-3.5 w-3.5" />
          {data.stats.correctToday} correct
        </span>
      </div>

      {completed ? (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {data.attempt?.isCorrect === true && (
              <span className="inline-flex items-center gap-1 font-medium text-accent-text">
                <CheckCircle2 className="h-4 w-4" />
                Correct
              </span>
            )}
            {data.attempt?.score !== null && data.attempt?.score !== undefined && (
              <span className="text-secondary">
                {data.attempt.score}/{data.question.marks}
              </span>
            )}
          </div>
          {data.attempt?.isCorrect === false && data.attempt.correctAnswer && (
            <p className="text-sm font-medium text-danger">
              The answer is {data.attempt.correctAnswer}.
            </p>
          )}
          <AiNotice notices={[notice]} />
          {feedback && (
            <div className="rounded-md bg-surface-raised p-3 text-xs text-secondary">
              <span className="font-semibold text-secondary">Feedback: </span>
              {feedback}
            </div>
          )}
          {/* The point of the exercise. A verdict with nothing to learn from is
              not feedback, and withholding this was the original defect. */}
          {(data.attempt?.markSchemeMd || (data.attempt?.markSchemeStrips?.length ?? 0) > 0) && (
            <details className="rounded-md border border-line">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-secondary">
                Mark scheme
              </summary>
              <div className="border-t border-line p-3">
                <ChallengeContent
                  content={data.attempt?.markSchemeMd ?? null}
                  strips={data.attempt?.markSchemeStrips}
                  alt={`Mark scheme for question ${data.question.number}`}
                />
              </div>
            </details>
          )}
          <p className="flex items-center gap-1 text-[11px] text-muted">
            <Lock className="h-3 w-3" />
            Next challenge tomorrow.
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {/* Four buttons, not a free-text box asking for one of four letters.
              The options live in the crop the student is reading; the key tells
              us how many there are. */}
          {data.question.options ? (
            <div className="flex flex-wrap gap-2">
              {data.question.options.map((letter) => (
                <button
                  key={letter}
                  type="button"
                  disabled={submitting}
                  onClick={() => void submit(letter)}
                  className="h-10 w-10 rounded-md border border-strong text-sm font-semibold text-secondary hover:border-accent hover:bg-accent-subtle disabled:opacity-50"
                >
                  {letter}
                </button>
              ))}
            </div>
          ) : (
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Your answer"
              rows={2}
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-primary outline-none focus:border-accent"
            />
          )}
          {error && <p className="text-[11px] text-danger">{error}</p>}
          {!data.question.options && (
            <button
              onClick={() => void submit()}
              disabled={!answer.trim() || submitting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-accent py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {submitting ? 'Marking…' : 'Submit'}
            </button>
          )}
          {submitting && data.question.options && (
            <p className="flex items-center gap-1 text-[11px] text-muted">
              <Loader2 className="h-3 w-3 animate-spin" /> Marking…
            </p>
          )}
        </div>
      )}
    </div>
  );
}
