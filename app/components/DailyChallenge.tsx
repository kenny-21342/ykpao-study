'use client';

/*
 * next/image is deliberately not used for the crops below: they are
 * session-gated strips from /bank_assets/**, which the optimiser would fetch
 * server-side without the viewer's cookie and get a 401 for.
 */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from 'react';
import { CalendarCheck, CheckCircle2, Loader2, Lock, Sparkles, Trophy, Users } from 'lucide-react';
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
            className="block max-w-full"
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
      <div className="floating-panel rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading daily challenge…</span>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const completed = Boolean(data.attempt);

  return (
    <div className="floating-panel rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300">
            <CalendarCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Daily challenge</h3>
            <p className="truncate text-[11px] text-gray-500 dark:text-gray-400">
              {data.question.paper.subject}
              {data.question.topic ? ` · ${data.question.topic}` : ''}
            </p>
          </div>
        </div>
        {completed && (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-1 text-[10px] font-semibold text-green-700 dark:bg-green-900/40 dark:text-green-300">
            <CheckCircle2 className="h-3 w-3" />
            Done
          </span>
        )}
      </div>

      <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-800 dark:bg-gray-950/40">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            Q{data.question.number}
            {data.question.part ? `${data.question.part}` : ''} · {data.question.paper.year}
          </span>
          <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
            {data.question.marks} {data.question.marks === 1 ? 'mark' : 'marks'}
          </span>
        </div>
        <div className="mt-2 text-sm text-gray-800 dark:text-gray-200">
          <ChallengeContent
            content={data.question.content}
            strips={data.question.strips}
            alt={`Question ${data.question.number}`}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-gray-500 dark:text-gray-400">
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
              <span className="inline-flex items-center gap-1 font-medium text-green-600 dark:text-green-400">
                <CheckCircle2 className="h-4 w-4" />
                Correct
              </span>
            )}
            {data.attempt?.score !== null && data.attempt?.score !== undefined && (
              <span className="text-gray-600 dark:text-gray-400">
                {data.attempt.score}/{data.question.marks}
              </span>
            )}
          </div>
          {data.attempt?.isCorrect === false && data.attempt.correctAnswer && (
            <p className="text-sm font-medium text-red-600 dark:text-red-400">
              The answer is {data.attempt.correctAnswer}.
            </p>
          )}
          {notice && (
            <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              {notice}
            </div>
          )}
          {feedback && (
            <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600 dark:bg-gray-950/40 dark:text-gray-400">
              <span className="font-semibold text-gray-700 dark:text-gray-300">Feedback: </span>
              {feedback}
            </div>
          )}
          {/* The point of the exercise. A verdict with nothing to learn from is
              not feedback, and withholding this was the original defect. */}
          {(data.attempt?.markSchemeMd || (data.attempt?.markSchemeStrips?.length ?? 0) > 0) && (
            <details className="rounded-lg border border-gray-200 dark:border-gray-800">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-gray-700 dark:text-gray-300">
                Mark scheme
              </summary>
              <div className="border-t border-gray-200 p-3 dark:border-gray-800">
                <ChallengeContent
                  content={data.attempt?.markSchemeMd ?? null}
                  strips={data.attempt?.markSchemeStrips}
                  alt={`Mark scheme for question ${data.question.number}`}
                />
              </div>
            </details>
          )}
          <p className="flex items-center gap-1 text-[11px] text-gray-400">
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
                  className="h-10 w-10 rounded-lg border border-gray-300 text-sm font-semibold text-gray-700 hover:border-emerald-500 hover:bg-emerald-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:border-emerald-500 dark:hover:bg-emerald-900/30"
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
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-emerald-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
            />
          )}
          {error && <p className="text-[11px] text-red-500">{error}</p>}
          {!data.question.options && (
            <button
              onClick={() => void submit()}
              disabled={!answer.trim() || submitting}
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {submitting ? 'Marking…' : 'Submit'}
            </button>
          )}
          {submitting && data.question.options && (
            <p className="flex items-center gap-1 text-[11px] text-gray-400">
              <Loader2 className="h-3 w-3 animate-spin" /> Marking…
            </p>
          )}
        </div>
      )}
    </div>
  );
}
