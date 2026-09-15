'use client';

import { useState, useEffect } from 'react';
import { GraduationCap, Loader2, Check, X, Sparkles } from 'lucide-react';

type Course = {
  id: string;
  name: string;
  code: string;
  subject: string;
  level: string;
  description: string | null;
  scopes?: Array<{ subjectCode: string }>;
};

// Only levels the course catalogue actually carries. AP and Other were listed
// here but had no catalogue entries behind them, so selecting either showed an
// empty picker; add them back alongside their courses, not before.
const LEVELS = ['All', 'IGCSE', 'A Level', 'IB'];

export default function OnboardingWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [levelFilter, setLevelFilter] = useState('All');
  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourseIds, setSelectedCourseIds] = useState<Set<string>>(new Set());
  const [targetGrade, setTargetGrade] = useState('');
  const [examDate, setExamDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/onboarding')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setCourses(data.courses ?? []);
        if (Array.isArray(data.enrolledCourseIds)) {
          setSelectedCourseIds(new Set(data.enrolledCourseIds));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggleCourse = (id: string) => {
    setSelectedCourseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const totalSelected = selectedCourseIds.size;

  const visibleCourses = courses.filter(
    (c) => levelFilter === 'All' || c.level === levelFilter
  );

  /**
   * Dismiss the wizard for good.
   *
   * This used to call `onComplete()` alone, which only hides the modal — the
   * server never learned the user had skipped, so the wizard came back on the
   * next page load and every one after it. Persist first; close regardless,
   * because a failed skip must not trap the user behind a modal they are
   * trying to dismiss. The worst case is that it reappears once more.
   */
  const handleSkip = async () => {
    try {
      await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skip: true }),
      });
    } catch {
      // Deliberately ignored — see above.
    }
    onComplete();
  };

  const handleFinish = async () => {
    if (totalSelected === 0) {
      setError('Please pick at least one subject.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          courses: Array.from(selectedCourseIds).map((courseId) => ({
            courseId,
            targetGrade: targetGrade.trim() || null,
            examDate: examDate || null,
          })),
          name: name.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <Loader2 className="w-6 h-6 animate-spin text-white" />
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-overlay w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-7 py-5 bg-accent text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-lg bg-white/20 flex items-center justify-center">
              <GraduationCap className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-lg font-bold">Welcome to YKPao Study!</h2>
              <p className="text-xs text-white/80">Let&apos;s personalize your experience ({step + 1}/2)</p>
            </div>
          </div>
          <button
            onClick={() => void handleSkip()}
            className="p-2 text-white/70 hover:text-white hover:bg-white/10 rounded-md transition-colors"
            title="Skip for now"
            aria-label="Skip setup for now"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step indicator */}
        <div className="px-7 pt-4">
          <div className="flex gap-2">
            <div className={`h-1.5 flex-1 rounded-full ${step >= 0 ? 'bg-green-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
            <div className={`h-1.5 flex-1 rounded-full ${step >= 1 ? 'bg-green-500' : 'bg-gray-200 dark:bg-gray-700'}`} />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-7 py-6">
          {step === 0 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">What should we call you?</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  Your name helps us greet you across the app. You can change it later.
                </p>
              </div>

              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Alex Chen (optional)"
                className="w-full px-4 py-3 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                autoFocus
              />
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div>
                <h3 className="text-xl font-bold text-gray-900 dark:text-gray-100">Which subjects do you study?</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  We&apos;ll filter the dashboard, notes, and questions to the subjects you pick.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  value={targetGrade}
                  onChange={(event) => setTargetGrade(event.target.value)}
                  placeholder="Target grade (optional)"
                  className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                />
                <input
                  type="date"
                  value={examDate}
                  onChange={(event) => setExamDate(event.target.value)}
                  aria-label="Exam date (optional)"
                  className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                />
              </div>

              {/* Level filter */}
              <div className="flex flex-wrap gap-2">
                {LEVELS.map((lvl) => (
                  <button
                    key={lvl}
                    onClick={() => setLevelFilter(lvl)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                      levelFilter === lvl
                        ? 'bg-green-600 text-white'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                    }`}
                  >
                    {lvl}
                  </button>
                ))}
              </div>

              {/* Controlled course catalog */}
              {visibleCourses.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Courses and curriculum</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {visibleCourses.map((c) => (
                      <SubjectChip
                        key={c.id}
                        label={c.name}
                        sub={`${c.scopes?.[0]?.subjectCode ?? 'Mapping needed'} • ${c.level}`}
                        selected={selectedCourseIds.has(c.id)}
                        onClick={() => toggleCourse(c.id)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {visibleCourses.length === 0 && <p className="text-sm text-gray-500">No courses are available for this level yet.</p>}

              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-7 py-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div className="text-xs text-gray-500">
            {step === 1 && totalSelected > 0 && (
              <span className="inline-flex items-center gap-1">
                <Check className="w-3.5 h-3.5 text-green-600" /> {totalSelected} selected
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                disabled={submitting}
                className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
              >
                Back
              </button>
            )}
            {step < 1 ? (
              <button
                onClick={() => setStep((s) => s + 1)}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all"
              >
                Next
              </button>
            ) : (
              <button
                onClick={handleFinish}
                disabled={submitting}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all disabled:opacity-60"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {submitting ? 'Saving…' : 'Get Started'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SubjectChip({
  label,
  sub,
  selected,
  onClick,
}: {
  label: string;
  sub: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-3 p-3 rounded-lg border text-left transition-all ${
        selected
          ? 'border-green-500 bg-green-50 dark:bg-green-900/20 ring-1 ring-green-500'
          : 'border-gray-200 dark:border-gray-700 hover:border-green-300 hover:bg-gray-50 dark:hover:bg-gray-700/50'
      }`}
    >
      <div
        className={`w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 ${
          selected ? 'bg-green-500 text-white' : 'border border-gray-300 dark:border-gray-600'
        }`}
      >
        {selected && <Check className="w-3.5 h-3.5" />}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{label}</p>
        <p className="text-xs text-gray-500 truncate">{sub}</p>
      </div>
    </button>
  );
}
