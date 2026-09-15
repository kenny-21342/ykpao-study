'use client';

import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Check, Loader2, Save } from 'lucide-react';

type CatalogCourse = {
  id: string;
  name: string;
  code: string;
  subject: string;
  level: string;
  catalogManaged: boolean;
  curriculumScopes: Array<{ board: string; qualification: string; level: string; subjectCode: string }>;
};

type Preference = {
  targetGrade: string;
  examDate: string;
  currentLevel: string;
  recentResult: string;
  personalizationEnabled: boolean;
};

export default function CoursesGoalsPanel() {
  const [catalog, setCatalog] = useState<CatalogCourse[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preferences, setPreferences] = useState<Record<string, Preference>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signals, setSignals] = useState<Array<{ courseId: string; topic: string; mastery: number | null; attempts: number; confidence: number }>>([]);

  useEffect(() => {
    fetch('/api/me/courses')
      .then((response) => response.ok ? response.json() : null)
      .then((data) => {
        if (!data) return;
        const enrolled = data.context?.enrolledCourses ?? [];
        setCatalog(data.catalog ?? []);
        setSignals(data.context?.weakTopics ?? []);
        setSelected(new Set(enrolled.map((course: { id: string }) => course.id)));
        setPreferences(Object.fromEntries(enrolled.map((course: { id: string; targetGrade: string | null; examDate: string | null; currentLevel: string | null; recentResult: string | null; personalizationEnabled: boolean }) => [course.id, {
          targetGrade: course.targetGrade ?? '',
          examDate: course.examDate ? course.examDate.slice(0, 10) : '',
          currentLevel: course.currentLevel ?? '',
          recentResult: course.recentResult ?? '',
          personalizationEnabled: course.personalizationEnabled,
        }])));
      })
      .catch(() => setError('Could not load your courses.'))
      .finally(() => setLoading(false));
  }, []);

  const selectedCourses = useMemo(() => catalog.filter((course) => selected.has(course.id)), [catalog, selected]);
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const updatePreference = (courseId: string, patch: Partial<Preference>) => setPreferences((current) => ({
    ...current,
    [courseId]: { ...(current[courseId] ?? { targetGrade: '', examDate: '', currentLevel: '', recentResult: '', personalizationEnabled: true }), ...patch },
  }));

  const save = async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const response = await fetch('/api/me/courses', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ courses: selectedCourses.map((course) => ({ courseId: course.id, ...(preferences[course.id] ?? {}) })) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not save courses.');
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save courses.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex items-center gap-2 text-sm text-muted"><Loader2 className="w-4 h-4 animate-spin" /> Loading courses…</div>;

  return (
    <section className="bg-white/70 dark:bg-gray-800/60 backdrop-blur-xl border border-white/40 dark:border-gray-700/50 rounded-lg p-6 space-y-5">
      <div className="flex items-center gap-2">
        <BookOpen className="w-5 h-5 text-accent-text" />
        <h2 className="text-lg font-bold text-primary">Courses &amp; goals</h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {catalog.map((course) => (
          <button key={course.id} type="button" onClick={() => toggle(course.id)} className={`text-left px-3 py-2.5 rounded-lg border transition-colors ${selected.has(course.id) ? 'border-accent bg-accent-subtle' : 'border-line bg-white/50 dark:bg-gray-900/30'}`}>
            <span className="block text-sm font-medium text-primary">{course.name}</span>
            <span className="text-xs text-muted">{course.level} · Syllabus {course.curriculumScopes[0]?.subjectCode ?? 'mapping needed'}</span>
          </button>
        ))}
      </div>
      {selectedCourses.map((course) => {
        const preference = preferences[course.id] ?? { targetGrade: '', examDate: '', currentLevel: '', recentResult: '', personalizationEnabled: true };
        return (
          <div key={course.id} className="border-t border-line pt-4 space-y-3">
            <div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-primary">{course.name}</h3><label className="text-xs text-muted inline-flex items-center gap-2"><input type="checkbox" checked={preference.personalizationEnabled} onChange={(event) => updatePreference(course.id, { personalizationEnabled: event.target.checked })} /> Use activity signals</label></div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input value={preference.targetGrade} onChange={(event) => updatePreference(course.id, { targetGrade: event.target.value })} placeholder="Target grade" className="px-3 py-2 bg-surface-raised border border-strong rounded-md text-sm" />
              <input type="date" value={preference.examDate} onChange={(event) => updatePreference(course.id, { examDate: event.target.value })} aria-label={`${course.name} exam date`} className="px-3 py-2 bg-surface-raised border border-strong rounded-md text-sm" />
              <input value={preference.currentLevel} onChange={(event) => updatePreference(course.id, { currentLevel: event.target.value })} placeholder="Current level" className="px-3 py-2 bg-surface-raised border border-strong rounded-md text-sm" />
              <input value={preference.recentResult} onChange={(event) => updatePreference(course.id, { recentResult: event.target.value })} placeholder="Recent result" className="px-3 py-2 bg-surface-raised border border-strong rounded-md text-sm" />
            </div>
          </div>
        );
      })}
      {signals.length > 0 && <div className="border-t border-line pt-4"><p className="text-xs font-semibold uppercase text-muted">Activity signals in use</p><div className="mt-2 space-y-1">{signals.slice(0, 6).map((signal) => <div key={`${signal.courseId}-${signal.topic}`} className="flex items-center justify-between text-xs text-secondary"><span>{signal.topic} · {signal.attempts} official attempt{signal.attempts === 1 ? '' : 's'}</span><span>{signal.mastery == null ? 'Not enough data' : `${signal.mastery}% mastery`} · {Math.round(signal.confidence * 100)}% confidence</span></div>)}</div></div>}
      {error && <p className="text-sm text-danger">{error}</p>}
      <button type="button" onClick={save} disabled={saving} className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg disabled:opacity-50"><Save className="w-4 h-4" />{saving ? 'Saving…' : saved ? <><Check className="w-4 h-4" /> Saved</> : 'Save courses'}</button>
    </section>
  );
}
