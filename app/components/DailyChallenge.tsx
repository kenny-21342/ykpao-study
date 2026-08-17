'use client';

import { useEffect, useState } from 'react';
import { CalendarCheck, CheckCircle2, Loader2, Lock, Sparkles, Trophy, Users } from 'lucide-react';
import FormattedMessage from './FormattedMessage';

type ChallengeQuestion = {
  id: number;
  number: number;
  part: string;
  content: string;
  marks: number;
  topic: string;
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
  } | null;
  stats: { participants: number; correctToday: number };
};

export default function DailyChallenge() {
  const [data, setData] = useState<ChallengeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');

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

  const submit = async () => {
    if (!answer.trim() || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/daily-challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(json?.error ?? 'Submission failed');
      } else {
        setFeedback(json?.feedback ?? '');
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
              {data.question.paper.subject} · {data.question.topic}
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
            {data.question.marks} marks
          </span>
        </div>
        <div className="mt-2 text-sm text-gray-800 dark:text-gray-200">
          <FormattedMessage content={data.question.content} />
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
          {feedback && (
            <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600 dark:bg-gray-950/40 dark:text-gray-400">
              <span className="font-semibold text-gray-700 dark:text-gray-300">AI feedback: </span>
              {feedback}
            </div>
          )}
          <p className="flex items-center gap-1 text-[11px] text-gray-400">
            <Lock className="h-3 w-3" />
            Next challenge tomorrow.
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="e.g. x = 6"
            rows={2}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-emerald-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
          />
          {error && <p className="text-[11px] text-red-500">{error}</p>}
          <button
            onClick={submit}
            disabled={!answer.trim() || submitting}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {submitting ? 'Grading…' : 'Submit'}
          </button>
        </div>
      )}
    </div>
  );
}
