'use client';

/*
 * next/image is deliberately not used for the crops below: they are
 * session-gated strips from /bank_assets/**, which the optimiser would fetch
 * server-side without the viewer's cookie and get a 401 for.
 */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import toast from 'react-hot-toast';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Brain,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  FileSearch,
  GraduationCap,
  Layers,
  ListChecks,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Target,
  Trash2,
  X,
} from 'lucide-react';
import { useConfirm } from './useConfirm';
import FormattedMessage from './FormattedMessage';
import { plainTextPreview } from '@/lib/latex';

type CoachView = 'today' | 'plan' | 'mistakes' | 'review' | 'decks' | 'mastery' | 'search';

type StudyTask = {
  id: string;
  questionId: number | null;
  /** Set when the task points at the crop-first bank instead. */
  bankQuestionId: number | null;
  title: string;
  subject: string;
  topic: string;
  taskType: string;
  source: string;
  dueAt: string;
  durationMinutes: number;
  status: string;
};

type ReviewStrip = { url: string; width: number | null; height: number | null };

type ReviewItem = {
  id: string;
  questionId: number | null;
  bankQuestionId: number | null;
  prompt: string;
  answer: string;
  /** Non-empty when the question is a crop rather than transcribed text. */
  promptStrips?: ReviewStrip[];
  /** Non-empty when the mark scheme is an image with no prose behind it. */
  answerStrips?: ReviewStrip[];
  subject: string;
  topic: string;
  status: string;
  nextReviewAt: string;
  intervalDays: number;
  repetitions: number;
  lapses: number;
};

type MasteryTopic = {
  subject: string;
  subjectCode: string;
  topic: string;
  totalQuestions: number;
  attemptedQuestions: number;
  coverage: number;
  mastery: number | null;
  accuracy: number | null;
  attempts: number;
};

type Mistake = {
  attemptId: string;
  /**
   * Which corpus the question lives in. The legacy text bank and the
   * crop-first bank are separate tables with separate id sequences, so an id
   * alone cannot say where to open it.
   */
  corpus: 'legacy' | 'bank';
  questionId: number | null;
  bankQuestionId: number | null;
  question: string;
  subject: string;
  subjectCode: string;
  topic: string;
  code: string;
  score: number | null;
  maxScore: number | null;
  answer: string;
  explanation: string | null;
  modelAnswer: string | null;
  weaknesses: string[];
  attemptedAt: string;
  reviewId: string | null;
};

type QueueItem = {
  questionId: number;
  subject: string;
  topic: string;
  title: string;
  reason: string;
  kind: string;
  marks?: number;
  code?: string;
};

type LearningProfile = {
  examDate: string | null;
  weeklyStudyMinutes: number;
  targetGrade: string;
  availability: Record<string, number>;
};

type CommandTermStat = {
  slug: string;
  label: string;
  band: 'recall' | 'procedure' | 'higher';
  attempts: number;
  correct: number;
  accuracy: number;
  markBased: boolean;
  guidance: string;
};

type Overview = {
  profile: LearningProfile | null;
  todayTasks: StudyTask[];
  overdueTasks: StudyTask[];
  dueReviews: number;
  reviewQueue: ReviewItem[];
  mistakes: Mistake[];
  mastery: MasteryTopic[];
  /** Weakest first; empty until the command-term backfill has run. */
  commandTerms: CommandTermStat[];
  weakestCommandTerm: CommandTermStat | null;
  /** Null unless enough attempts were marked twice; see lib/self-marking. */
  calibrationNote: string | null;
  /** Null when the profile carries no future exam date. */
  examCountdown: string | null;
  daysUntilExam: number | null;
  adaptiveQueue: QueueItem[];
  subjects: string[];
  latestExam: { id: string; title: string; score: number | null; totalMarks: number; submittedAt: string | null } | null;
  summary: { topicsStarted: number; topicsMastered: number; tasksDue: number; activeReviews: number };
};

type SearchResult = {
  id: string;
  type: 'question' | 'markscheme' | 'note' | 'textbook' | 'resource';
  title: string;
  snippet: string;
  url: string;
  subject?: string | null;
  topic?: string | null;
};

type TaskHandlers = {
  onOpenQuestion: (id: number) => void;
  onOpenBankQuestion: (id: number) => void;
  onOpenMockExams: () => void;
};

/**
 * Where a planned task leads. The bank id is checked first because that is
 * what `generatePlan` writes now; `questionId` is only set on tasks generated
 * before the plan moved to the crop-first corpus, and on hand-made ones.
 */
function openTaskTarget(task: StudyTask, handlers: TaskHandlers) {
  if (task.bankQuestionId) return handlers.onOpenBankQuestion(task.bankQuestionId);
  if (task.questionId) return handlers.onOpenQuestion(task.questionId);
  if (task.taskType === 'mock-exam') return handlers.onOpenMockExams();
}

const NAV: Array<{ id: CoachView; label: string; icon: typeof CalendarDays }> = [
  { id: 'today', label: 'Today', icon: CalendarDays },
  { id: 'plan', label: 'Plan', icon: ListChecks },
  { id: 'mistakes', label: 'Mistakes', icon: AlertCircle },
  { id: 'review', label: 'Review', icon: Brain },
  { id: 'decks', label: 'Cards', icon: Layers },
  { id: 'mastery', label: 'Coverage', icon: Target },
  { id: 'search', label: 'Search', icon: Search },
];

const DAYS = [
  { key: '1', label: 'Mon' }, { key: '2', label: 'Tue' }, { key: '3', label: 'Wed' },
  { key: '4', label: 'Thu' }, { key: '5', label: 'Fri' }, { key: '6', label: 'Sat' },
  { key: '0', label: 'Sun' },
];

const EMPTY_AVAILABILITY = { 0: 45, 1: 45, 2: 45, 3: 45, 4: 45, 5: 60, 6: 60 };

export default function StudyCoach({
  onOpenQuestion,
  onOpenBankQuestion,
  onOpenMockExams,
  initialView = 'today',
}: {
  /** Opens a question in the legacy text bank, by `past_paper_questions.id`. */
  onOpenQuestion: (questionId: number) => void;
  /**
   * Opens a question in the crop-first bank, by `bank_questions.id`. Separate
   * from `onOpenQuestion` because the two corpora are separate tables: passing
   * one id to the other browser lands on an unrelated question, or on nothing.
   */
  onOpenBankQuestion: (bankQuestionId: number) => void;
  onOpenMockExams: () => void;
  initialView?: CoachView;
}) {
  const { confirm, confirmDialog } = useConfirm();
  const { status } = useSession();
  const [view, setView] = useState<CoachView>(initialView);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tasks, setTasks] = useState<StudyTask[]>([]);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  // True once the first fetch has settled, so later refreshes update in place
  // instead of tearing the screen down to a spinner.
  const [hasLoaded, setHasLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [selectedSubject, setSelectedSubject] = useState('all');

  useEffect(() => {
    const timer = window.setTimeout(() => setView(initialView), 0);
    return () => window.clearTimeout(timer);
  }, [initialView]);

  const load = useCallback(async () => {
    if (status !== 'authenticated') {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [overviewRes, tasksRes, reviewsRes] = await Promise.all([
        fetch('/api/learning/overview'),
        fetch('/api/learning/tasks'),
        fetch('/api/learning/reviews?mode=all'),
      ]);
      if (!overviewRes.ok || !tasksRes.ok || !reviewsRes.ok) throw new Error('Study data could not be loaded.');
      const [overviewData, tasksData, reviewsData] = await Promise.all([
        overviewRes.json(), tasksRes.json(), reviewsRes.json(),
      ]);
      setOverview(overviewData);
      setTasks(tasksData.tasks ?? []);
      setReviews(reviewsData.reviews ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Study data could not be loaded.');
    } finally {
      setLoading(false);
      setHasLoaded(true);
    }
  }, [status]);

  // Initial remote-data synchronization for this client workspace.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const updateTask = async (id: string, taskStatus: 'pending' | 'completed' | 'skipped') => {
    setBusy(id);
    try {
      const res = await fetch('/api/learning/tasks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: taskStatus }),
      });
      if (!res.ok) throw new Error('Task could not be updated.');
      await load();
    } catch (taskError) {
      setError(taskError instanceof Error ? taskError.message : 'Task could not be updated.');
    } finally {
      setBusy(null);
    }
  };

  const deleteTask = async (id: string) => {
    // The one destructive control on this screen that had no confirmation at
    // all: a single click on a small bin icon, next to the tick that completes
    // a task, removed it with no undo and no warning.
    const ok = await confirm({
      title: 'Delete this task?',
      message: 'It is removed from your plan. Rebuilding the week will not bring it back.',
      confirmLabel: 'Delete task',
    });
    if (!ok) return;
    setBusy(id);
    try {
      const res = await fetch(`/api/learning/tasks?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Task could not be deleted.');
      await load();
    } catch (taskError) {
      setError(taskError instanceof Error ? taskError.message : 'Task could not be deleted.');
    } finally {
      setBusy(null);
    }
  };

  const generatePlan = async () => {
    setBusy('generate');
    setError(null);
    try {
      const res = await fetch('/api/learning/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate' }),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Plan could not be generated.');
      await load();
    } catch (planError) {
      setError(planError instanceof Error ? planError.message : 'Plan could not be generated.');
    } finally {
      setBusy(null);
    }
  };

  const addMistakeToReview = async (mistake: Mistake) => {
    setBusy(`mistake-${mistake.attemptId}`);
    try {
      const res = await fetch('/api/learning/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId: mistake.questionId }),
      });
      if (!res.ok) throw new Error('Review item could not be created.');
      await load();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Review item could not be created.');
    } finally {
      setBusy(null);
    }
  };

  const rateReview = async (id: string, rating: 'again' | 'hard' | 'good' | 'easy') => {
    setBusy(id);
    try {
      const res = await fetch('/api/learning/reviews', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, rating }),
      });
      if (!res.ok) throw new Error('Review could not be scheduled.');
      await load();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Review could not be scheduled.');
    } finally {
      setBusy(null);
    }
  };

  // Only blank the screen on the *first* load. Every later refresh — ticking a
  // task, saving preferences, hitting the refresh button — also calls load(),
  // and gating on `loading` alone replaced the whole Study screen with a
  // spinner each time, losing scroll position and the open tab.
  if (status === 'loading' || (loading && !hasLoaded)) {
    return <div className="h-full grid place-items-center"><Loader2 className="w-7 h-7 animate-spin text-green-600" /></div>;
  }

  if (status !== 'authenticated') {
    return (
      <div className="h-full grid place-items-center p-6">
        <div className="max-w-md text-center">
          <GraduationCap className="w-10 h-10 mx-auto text-green-600 mb-4" />
          <h2 className="text-xl font-bold text-primary">Sign in to use Study</h2>
          <p className="text-sm text-secondary mt-2">Your plan, mistakes, review schedule, and mastery history are private to your account.</p>
          <a href="/auth/login" className="inline-flex mt-5 px-4 py-2.5 bg-green-600 text-white text-sm font-semibold rounded-md hover:bg-green-700">Sign in</a>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-white/50 dark:bg-gray-950/30">
      <div className="border-b border-line bg-white/80 dark:bg-gray-900/80 px-4 md:px-6">
        <div className="flex items-center justify-between gap-4 min-h-16">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-primary">Study</h2>
            <p className="text-xs text-muted truncate">Plan from deadlines, mistakes, and mastery</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void load()} title="Refresh" aria-label="Refresh" className="w-9 h-9 grid place-items-center rounded-md border border-line hover:bg-surface-hover">
              <RefreshCw className="w-4 h-4" />
            </button>
            <button onClick={() => setProfileOpen((open) => !open)} className="inline-flex items-center gap-2 h-9 px-3 rounded-md border border-line text-sm font-medium hover:bg-surface-hover">
              <Settings2 className="w-4 h-4" />
              <span className="hidden sm:inline">Preferences</span>
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1 overflow-x-auto pb-2">
          {NAV.map((item) => {
            const Icon = item.icon;
            const badge = item.id === 'review' ? overview?.dueReviews : item.id === 'mistakes' ? overview?.mistakes.length : null;
            return (
              <button key={item.id} onClick={() => setView(item.id)} className={`h-9 px-3 inline-flex items-center gap-2 rounded-md text-sm font-medium whitespace-nowrap ${view === item.id ? 'bg-surface-inverse text-inverse' : 'text-secondary hover:bg-surface-hover'}`}>
                <Icon className="w-4 h-4" />{item.label}
                {!!badge && <span className="min-w-5 h-5 px-1 grid place-items-center rounded-full text-[11px] bg-red-100 text-red-700">{badge}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="mx-4 md:mx-6 mt-4 flex items-center gap-3 px-4 py-3 border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-900 rounded-md text-sm text-red-700 dark:text-red-300">
          <AlertCircle className="w-4 h-4 flex-none" /><span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} title="Dismiss" aria-label="Dismiss"><X className="w-4 h-4" /></button>
        </div>
      )}

      {confirmDialog}

      <div className="flex-1 overflow-y-auto">
        {profileOpen && <ProfileEditor profile={overview?.profile ?? null} onSaved={async () => { setProfileOpen(false); await load(); }} />}
        {view === 'today' && overview && (
          <TodayView overview={overview} busy={busy} onComplete={updateTask} onOpenQuestion={onOpenQuestion} onOpenBankQuestion={onOpenBankQuestion} onOpenMockExams={onOpenMockExams} onGenerate={generatePlan} onReview={() => setView('review')} />
        )}
        {view === 'plan' && (
          <PlanView tasks={tasks} busy={busy} taskFormOpen={taskFormOpen} setTaskFormOpen={setTaskFormOpen} onGenerate={generatePlan} onUpdate={updateTask} onDelete={deleteTask} onCreated={load} onOpenQuestion={onOpenQuestion} onOpenBankQuestion={onOpenBankQuestion} onOpenMockExams={onOpenMockExams} />
        )}
        {view === 'mistakes' && overview && (
          <MistakesView mistakes={overview.mistakes} busy={busy} onOpenQuestion={onOpenQuestion} onOpenBankQuestion={onOpenBankQuestion} onAddReview={addMistakeToReview} />
        )}
        {view === 'review' && (
          <ReviewView reviews={reviews} busy={busy} onRate={rateReview} onOpenQuestion={onOpenQuestion} />
        )}
        {view === 'decks' && <DeckBrowser onOpenQuestion={onOpenQuestion} />}
        {view === 'mastery' && overview && (
          <MasteryView topics={overview.mastery} subjects={overview.subjects} selectedSubject={selectedSubject} setSelectedSubject={setSelectedSubject} onOpenQuestion={onOpenQuestion} queue={overview.adaptiveQueue} />
        )}
        {view === 'search' && <SmartSearch onOpenQuestion={onOpenQuestion} />}
      </div>
    </div>
  );
}

function TodayView({ overview, busy, onComplete, onOpenQuestion, onOpenBankQuestion, onOpenMockExams, onGenerate, onReview }: {
  overview: Overview;
  busy: string | null;
  onComplete: (id: string, status: 'completed') => void;
  onOpenQuestion: (id: number) => void;
  onOpenBankQuestion: (id: number) => void;
  onOpenMockExams: () => void;
  onGenerate: () => void;
  onReview: () => void;
}) {
  const tasks = [...overview.overdueTasks, ...overview.todayTasks];
  const examPercent = overview.latestExam?.score != null && overview.latestExam.totalMarks > 0
    ? Math.round((overview.latestExam.score / overview.latestExam.totalMarks) * 100) : null;
  return (
    <main className="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Metric label="Tasks due" value={overview.summary.tasksDue} detail={`${overview.overdueTasks.length} overdue`} icon={ListChecks} />
        <Metric label="Reviews due" value={overview.dueReviews} detail={`${overview.summary.activeReviews} active cards`} icon={Brain} />
        <Metric label="Topics started" value={overview.summary.topicsStarted} detail={`${overview.summary.topicsMastered} at mastery`} icon={Target} />
        {overview.daysUntilExam === null ? (
          <Metric label="Latest mock" value={examPercent == null ? '-' : `${examPercent}%`} detail={overview.latestExam?.title ?? 'No completed exam'} icon={GraduationCap} />
        ) : (
          // The countdown replaces the mock tile rather than adding a fifth:
          // once an exam is close it is the number that should be on screen.
          <Metric label="Days to exam" value={overview.daysUntilExam} detail={overview.examCountdown ?? ''} icon={CalendarDays} />
        )}
      </section>

      <section className="grid lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)] gap-6">
        <div>
          <div className="flex items-center justify-between mb-3">
            <div><h3 className="font-bold text-primary">Today&apos;s plan</h3><p className="text-xs text-muted mt-0.5">Finish the smallest next action first</p></div>
            <button onClick={onGenerate} disabled={busy === 'generate'} className="inline-flex items-center gap-2 text-sm font-semibold text-green-700 dark:text-green-400 disabled:opacity-50">
              {busy === 'generate' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Build week
            </button>
          </div>
          <div className="border-y border-line divide-y divide-line bg-white/70 dark:bg-gray-900/50">
            {tasks.length === 0 ? <EmptyState icon={CheckCircle2} title="Nothing is due" body="Generate a weekly plan or add a task from the Plan view." /> : tasks.map((task) => (
              <div key={task.id} className="flex items-center gap-3 py-3 px-2">
                <button onClick={() => onComplete(task.id, 'completed')} disabled={busy === task.id} title="Complete task" aria-label="Complete task" className="w-8 h-8 grid place-items-center flex-none text-muted hover:text-green-600">
                  {busy === task.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Circle className="w-5 h-5" />}
                </button>
                <button onClick={() => openTaskTarget(task, { onOpenQuestion, onOpenBankQuestion, onOpenMockExams })} className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2"><p className="font-semibold text-sm text-primary truncate">{task.title}</p>{new Date(task.dueAt) < new Date() && <span className="text-[10px] font-semibold text-red-600">OVERDUE</span>}</div>
                  <p className="text-xs text-muted mt-1 truncate">{task.subject} · {task.topic} · {task.durationMinutes} min</p>
                </button>
                <ArrowRight className="w-4 h-4 text-muted flex-none" />
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <div><h3 className="font-bold text-primary">Focus queue</h3><p className="text-xs text-muted mt-0.5">Due reviews and weak topics in one list</p></div>
            {overview.dueReviews > 0 && <button onClick={onReview} className="text-sm font-semibold text-green-700 dark:text-green-400">Review now</button>}
          </div>
          <div className="space-y-2">
            {overview.adaptiveQueue.length === 0 ? <EmptyState icon={Brain} title="Queue is learning about you" body="Complete a few practice questions to receive targeted recommendations." /> : overview.adaptiveQueue.slice(0, 6).map((item, index) => (
              <button key={`${item.questionId}-${index}`} onClick={() => onOpenQuestion(item.questionId)} className="w-full text-left p-3 border border-line bg-surface rounded-md hover:border-green-400 transition-colors">
                <div className="flex items-start gap-3">
                  <span className="w-6 h-6 grid place-items-center rounded-full bg-surface-raised text-xs font-bold flex-none">{index + 1}</span>
                  <div className="min-w-0"><p className="text-sm font-semibold text-primary line-clamp-1">{item.code || item.topic}</p><p className="text-xs text-muted line-clamp-2 mt-1">{plainTextPreview(item.title)}</p><p className="text-[11px] text-green-700 dark:text-green-400 mt-1.5">{item.reason}</p></div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </section>

      {overview.calibrationNote && (
        <section className="rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-900/20">
          <h3 className="font-bold text-primary">How you mark yourself</h3>
          <p className="text-sm text-secondary mt-1">{overview.calibrationNote}</p>
        </section>
      )}

      <CommandTermPanel stats={overview.commandTerms} />
    </main>
  );
}

/**
 * Accuracy per command term.
 *
 * Topic coverage says what a student has not learned. This says what they are
 * not doing when the paper asks for it -- and it is the more actionable of the
 * two, because the fix is a habit rather than a syllabus.
 *
 * Hidden entirely when there is no data. A student whose subjects have not been
 * backfilled, or who has not practised enough for any term to mean anything,
 * gets nothing rather than an empty table or a figure built on two attempts.
 */
function CommandTermPanel({ stats }: { stats: CommandTermStat[] }) {
  // Only terms with enough attempts to say anything. The same threshold as
  // `MIN_ATTEMPTS_FOR_SIGNAL` on the server, applied again here because the
  // server sends the full list for the record.
  const shown = stats.filter((stat) => stat.attempts >= 4).slice(0, 6);
  if (shown.length === 0) return null;

  return (
    <section>
      <div className="mb-3">
        <h3 className="font-bold text-primary">Command terms</h3>
        <p className="text-xs text-muted mt-0.5">
          How you score by what the question asks you to do, weakest first
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((stat) => (
          <div
            key={stat.slug}
            className="p-3 border border-line bg-surface rounded-md"
          >
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-primary">{stat.label}</p>
              <p className="text-sm font-bold tabular-nums text-primary">
                {stat.accuracy}%
              </p>
            </div>
            <Progress
              value={stat.accuracy}
              color={stat.accuracy >= 80 ? 'bg-green-500' : stat.accuracy >= 50 ? 'bg-amber-500' : 'bg-red-500'}
            />
            <p className="text-[11px] text-muted mt-1">
              {stat.attempts} question{stat.attempts === 1 ? '' : 's'} ·{' '}
              {stat.markBased ? 'by marks awarded' : 'by full answers'}
            </p>
            {stat.accuracy < 70 && (
              <p className="text-[11px] text-secondary mt-1.5">{stat.guidance}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function Metric({ label, value, detail, icon: Icon }: { label: string; value: string | number; detail: string; icon: typeof Target }) {
  return <div className="p-4 border border-line bg-surface rounded-md"><div className="flex items-center justify-between"><p className="text-xs font-medium text-muted">{label}</p><Icon className="w-4 h-4 text-green-600" /></div><p className="text-2xl font-bold mt-2 text-primary">{value}</p><p className="text-[11px] text-muted mt-1 truncate">{detail}</p></div>;
}

function PlanView({ tasks, busy, taskFormOpen, setTaskFormOpen, onGenerate, onUpdate, onDelete, onCreated, onOpenQuestion, onOpenBankQuestion, onOpenMockExams }: {
  tasks: StudyTask[]; busy: string | null; taskFormOpen: boolean; setTaskFormOpen: (open: boolean) => void;
  onGenerate: () => void; onUpdate: (id: string, status: 'pending' | 'completed' | 'skipped') => void;
  onDelete: (id: string) => void; onCreated: () => Promise<void>; onOpenQuestion: (id: number) => void;
  onOpenBankQuestion: (id: number) => void; onOpenMockExams: () => void;
}) {
  const grouped = useMemo(() => tasks.reduce<Record<string, StudyTask[]>>((days, task) => {
    const key = new Date(task.dueAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
    (days[key] ??= []).push(task); return days;
  }, {}), [tasks]);
  return <main className="max-w-5xl mx-auto p-4 md:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3 mb-5"><div><h3 className="font-bold text-primary">Two-week plan</h3><p className="text-xs text-muted mt-1">Generated tasks are refreshed without changing your manual tasks</p></div><div className="flex gap-2"><button onClick={() => setTaskFormOpen(!taskFormOpen)} className="h-9 px-3 inline-flex items-center gap-2 border border-strong rounded-md text-sm font-semibold"><Plus className="w-4 h-4" /> Add task</button><button onClick={onGenerate} disabled={busy === 'generate'} className="h-9 px-3 inline-flex items-center gap-2 bg-green-600 text-white rounded-md text-sm font-semibold disabled:opacity-50">{busy === 'generate' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Rebuild week</button></div></div>
    {taskFormOpen && <TaskForm onCreated={async () => { setTaskFormOpen(false); await onCreated(); }} />}
    <div className="space-y-6 mt-5">{Object.keys(grouped).length === 0 ? <EmptyState icon={CalendarDays} title="No planned tasks" body="Build a week from your available time and weakest topics." /> : Object.entries(grouped).map(([day, dayTasks]) => <section key={day}><div className="flex items-center gap-3 mb-2"><h4 className="text-sm font-bold text-primary">{day}</h4><span className="text-xs text-muted">{dayTasks.reduce((sum, task) => sum + task.durationMinutes, 0)} min</span></div><div className="border-y border-line divide-y divide-line">{dayTasks.map((task) => <div key={task.id} className={`flex items-center gap-3 px-2 py-3 ${task.status !== 'pending' ? 'opacity-55' : ''}`}><button onClick={() => onUpdate(task.id, task.status === 'completed' ? 'pending' : 'completed')} className="w-8 h-8 grid place-items-center">{busy === task.id ? <Loader2 className="w-4 h-4 animate-spin" /> : task.status === 'completed' ? <CheckCircle2 className="w-5 h-5 text-green-600" /> : <Circle className="w-5 h-5 text-muted" />}</button><button onClick={() => openTaskTarget(task, { onOpenQuestion, onOpenBankQuestion, onOpenMockExams })} className="min-w-0 flex-1 text-left"><p className={`text-sm font-semibold text-primary truncate ${task.status === 'completed' ? 'line-through' : ''}`}>{task.title}</p><p className="text-xs text-muted mt-1">{task.subject} · {task.topic} · {task.durationMinutes} min</p></button><span className="hidden sm:inline text-[10px] px-2 py-1 bg-surface-raised rounded-sm font-medium uppercase">{task.taskType}</span><button onClick={() => onDelete(task.id)} title="Delete task" aria-label="Delete task" className="w-8 h-8 grid place-items-center text-muted hover:text-red-600"><Trash2 className="w-4 h-4" /></button></div>)}</div></section>)}</div>
  </main>;
}

function TaskForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [form, setForm] = useState({ title: '', subject: '', topic: '', taskType: 'practice', dueAt: '', durationMinutes: 30 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: React.FormEvent) => { event.preventDefault(); setSaving(true); setError(null); try { const res = await fetch('/api/learning/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, durationMinutes: Number(form.durationMinutes), dueAt: new Date(form.dueAt).toISOString() }) }); if (!res.ok) throw new Error((await res.json()).error || 'Task could not be saved.'); await onCreated(); } catch (submitError) { setError(submitError instanceof Error ? submitError.message : 'Task could not be saved.'); } finally { setSaving(false); } };
  return <form onSubmit={submit} className="grid md:grid-cols-6 gap-3 p-4 border border-line rounded-md bg-surface-raised"><input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Review Paper 2 mechanics" className="md:col-span-2 input-field" /><input required value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="e.g. Physics" className="input-field" /><input required value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} placeholder="e.g. Momentum" className="input-field" /><select value={form.taskType} onChange={(e) => setForm({ ...form, taskType: e.target.value })} className="input-field"><option value="practice">Practice</option><option value="review">Review</option><option value="notes">Notes</option><option value="mock-exam">Mock exam</option></select><input type="number" min="5" max="240" value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })} className="input-field" aria-label="Duration in minutes" /><input required type="datetime-local" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} className="md:col-span-2 input-field" /><div className="md:col-span-4 flex items-center justify-end gap-3">{error && <span className="text-xs text-red-600 mr-auto">{error}</span>}<button disabled={saving} className="h-9 px-4 rounded-md bg-surface-inverse text-inverse text-sm font-semibold disabled:opacity-50">{saving ? 'Saving...' : 'Create task'}</button></div></form>;
}

function MistakesView({ mistakes, busy, onOpenQuestion, onOpenBankQuestion, onAddReview }: { mistakes: Mistake[]; busy: string | null; onOpenQuestion: (id: number) => void; onOpenBankQuestion: (id: number) => void; onAddReview: (mistake: Mistake) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const openMistake = (mistake: Mistake) => {
    if (mistake.corpus === 'bank') {
      if (mistake.bankQuestionId) onOpenBankQuestion(mistake.bankQuestionId);
    } else if (mistake.questionId) {
      onOpenQuestion(mistake.questionId);
    }
  };
  return <main className="max-w-5xl mx-auto p-4 md:p-6"><div className="mb-5"><h3 className="font-bold text-primary">Mistake notebook</h3><p className="text-xs text-muted mt-1">Your latest unsuccessful attempt for each question</p></div>{mistakes.length === 0 ? <EmptyState icon={CheckCircle2} title="No recorded mistakes" body="Incorrect practice and mock-exam answers will appear here automatically." /> : <div className="border-y border-line divide-y divide-line">{mistakes.map((mistake) => <article key={mistake.attemptId} className="py-4 px-2"><div className="flex items-start gap-3"><button onClick={() => openMistake(mistake)} className="w-10 h-10 grid place-items-center rounded-md bg-red-50 dark:bg-red-950/30 text-red-600 flex-none"><AlertCircle className="w-5 h-5" /></button><button onClick={() => setExpanded(expanded === mistake.attemptId ? null : mistake.attemptId)} className="min-w-0 flex-1 text-left"><div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-bold text-primary">{mistake.code}</h4><span className="text-xs text-muted">{mistake.score ?? 0}/{mistake.maxScore ?? '-'}</span></div><p className="text-xs text-muted mt-1">{mistake.subject} · {mistake.topic} · {new Date(mistake.attemptedAt).toLocaleDateString()}</p><p className="text-sm text-secondary line-clamp-2 mt-2">{plainTextPreview(mistake.question)}</p></button><button onClick={() => mistake.reviewId ? undefined : onAddReview(mistake)} disabled={!!mistake.reviewId || busy === `mistake-${mistake.attemptId}` || (mistake.corpus === 'bank' && !mistake.reviewId)} title={mistake.corpus === 'bank' && !mistake.reviewId ? 'This question has no mark scheme to put on the back of a card' : undefined} aria-label={mistake.corpus === 'bank' && !mistake.reviewId ? 'This question has no mark scheme to put on the back of a card' : undefined} className="h-9 px-3 inline-flex items-center gap-2 rounded-md border border-strong text-xs font-semibold disabled:opacity-60">{busy === `mistake-${mistake.attemptId}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : mistake.reviewId ? <Check className="w-3.5 h-3.5 text-green-600" /> : <Plus className="w-3.5 h-3.5" />}{mistake.reviewId ? 'In review' : 'Add review'}</button></div>{expanded === mistake.attemptId && <div className="ml-13 mt-4 grid md:grid-cols-2 gap-4"><div><p className="text-xs font-bold text-muted uppercase mb-2">Your answer</p><p className="text-sm text-secondary">{mistake.answer || 'No answer submitted.'}</p>{mistake.weaknesses.length > 0 && <ul className="mt-3 space-y-1">{mistake.weaknesses.map((weakness) => <li key={weakness} className="text-xs text-red-700 dark:text-red-300">· {weakness}</li>)}</ul>}</div><div><p className="text-xs font-bold text-muted uppercase mb-2">Feedback</p>{mistake.explanation ? <FormattedMessage content={mistake.explanation} /> : <p className="text-sm text-muted">Open the question to review the mark scheme.</p>}</div></div>}</article>)}</div>}</main>;
}

/**
 * One face of a review card, whether it is text or a crop.
 *
 * Strips win when present: a crop-first question has no transcript, and 47,844
 * linked mark schemes are images with no `answerMd` at all. Rendering only
 * `answer` left those cards blank, which is the same failure as the placeholder
 * they replaced.
 */
function ReviewFace({ content, strips, alt }: { content: string; strips?: ReviewStrip[]; alt: string }) {
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
  return <FormattedMessage content={splitMcqOptionRun(content)} />;
}

// MCQ options arrive as a single run — "A metallic character B number of
// electron shells C…" — because the corpus stores them as flat text. Split
// before each letter of an increasing A→F run so they render as a readable
// list. The run has to be consecutive (A, then B, …) with actual option text
// between the letters, and at least three long — prose that merely contains
// capital letters ("Vitamin A B C deficiency") must not be mangled.
function splitMcqOptionRun(content: string): string {
  const letters = [...content.matchAll(/(?:^|(?<=\s))([A-F])(?=\s)/g)];
  let best: number[] = [];
  let run: number[] = [];
  for (const match of letters) {
    const letter = match[1];
    const index = match.index ?? 0;
    const expected = String.fromCharCode(65 + run.length);
    const hasOptionText =
      run.length === 0 || content.slice(run[run.length - 1] + 1, index).trim().length > 0;
    if (letter === expected && hasOptionText) {
      run.push(index);
    } else {
      if (run.length > best.length) best = run;
      run = letter === 'A' ? [index] : [];
    }
  }
  if (run.length > best.length) best = run;
  if (best.length < 3) return content;
  let out = content;
  for (let i = best.length - 1; i >= 0; i--) {
    if (best[i] > 0) out = `${out.slice(0, best[i])}\n${out.slice(best[i])}`;
  }
  return out;
}

function ReviewView({ reviews, busy, onRate, onOpenQuestion }: { reviews: ReviewItem[]; busy: string | null; onRate: (id: string, rating: 'again' | 'hard' | 'good' | 'easy') => void; onOpenQuestion: (id: number) => void }) {
  const due = reviews.filter((review) => review.status === 'active' && new Date(review.nextReviewAt) <= new Date());
  const [index, setIndex] = useState(0); const [revealed, setRevealed] = useState(false);
  const safeIndex = due.length > 0 ? index % due.length : 0;
  const item = due[safeIndex];
  const rate = async (rating: 'again' | 'hard' | 'good' | 'easy') => { if (!item) return; onRate(item.id, rating); setIndex(0); setRevealed(false); };
  return <main className="max-w-4xl mx-auto p-4 md:p-6"><div className="flex items-center justify-between mb-5"><div><h3 className="font-bold text-primary">Spaced review</h3><p className="text-xs text-muted mt-1">{due.length} due now · {reviews.filter((review) => review.status === 'active').length} active</p></div>{item?.questionId && <button onClick={() => onOpenQuestion(item.questionId!)} className="text-sm font-semibold text-green-700 dark:text-green-400">Open original</button>}</div>{!item ? <EmptyState icon={Brain} title="Reviews complete" body="Your next items will appear here when their interval is due." /> : <div className="min-h-[420px] border border-line rounded-md bg-surface flex flex-col"><div className="px-5 py-3 border-b border-line flex items-center justify-between text-xs text-muted"><span>{item.subject} · {item.topic}</span><span>{safeIndex + 1} / {due.length}</span></div><div className="flex-1 p-6 md:p-10"><p className="text-xs font-bold text-muted uppercase mb-4">Recall the answer</p><div className="text-base text-primary"><ReviewFace content={item.prompt} strips={item.promptStrips} alt="Question from the original paper" /></div>{revealed && <div className="mt-8 pt-6 border-t border-line"><p className="text-xs font-bold text-green-700 dark:text-green-400 uppercase mb-4">Answer</p><ReviewFace content={item.answer} strips={item.answerStrips} alt="Mark scheme from the original paper" /></div>}</div><div className="p-4 border-t border-line">{!revealed ? <button onClick={() => setRevealed(true)} className="w-full h-11 rounded-md bg-surface-inverse text-inverse text-sm font-semibold">Reveal answer</button> : <div className="grid grid-cols-4 gap-2">{(['again', 'hard', 'good', 'easy'] as const).map((rating) => <button key={rating} disabled={busy === item.id} onClick={() => void rate(rating)} className={`h-11 rounded-md text-sm font-semibold capitalize border ${rating === 'again' ? 'border-red-300 text-red-700' : rating === 'hard' ? 'border-amber-300 text-amber-700' : rating === 'good' ? 'border-green-300 text-green-700' : 'border-line text-secondary'} disabled:opacity-50`}>{rating}</button>)}</div>}</div></div>}</main>;
}

function MasteryView({ topics, subjects, selectedSubject, setSelectedSubject, onOpenQuestion, queue }: { topics: MasteryTopic[]; subjects: string[]; selectedSubject: string; setSelectedSubject: (subject: string) => void; onOpenQuestion: (id: number) => void; queue: QueueItem[] }) {
  const filtered = topics.filter((topic) => selectedSubject === 'all' || topic.subject === selectedSubject).sort((a, b) => (a.mastery ?? -1) - (b.mastery ?? -1));
  return <main className="max-w-6xl mx-auto p-4 md:p-6"><div className="flex flex-wrap items-center justify-between gap-3 mb-5"><div><h3 className="font-bold text-primary">Coverage by topic</h3><p className="text-xs text-muted mt-1">Coverage counts unique questions; mastery uses awarded marks</p></div><div className="relative"><select value={selectedSubject} onChange={(e) => setSelectedSubject(e.target.value)} className="appearance-none h-9 pl-3 pr-9 border border-strong rounded-md bg-surface text-sm"><option value="all">All subjects</option>{subjects.map((subject) => <option key={subject}>{subject}</option>)}</select><ChevronDown className="absolute right-3 top-2.5 w-4 h-4 pointer-events-none" /></div></div><div className="overflow-x-auto border-y border-line"><table className="w-full min-w-[680px] text-left"><thead><tr className="text-xs text-muted border-b border-line"><th className="py-3 px-3 font-semibold">Topic</th><th className="py-3 px-3 font-semibold w-52">Coverage</th><th className="py-3 px-3 font-semibold w-52">Mastery</th><th className="py-3 px-3 font-semibold text-right">Attempts</th></tr></thead><tbody className="divide-y divide-line">{filtered.map((topic) => <tr key={`${topic.subject}-${topic.topic}`}><td className="py-3 px-3"><p className="text-sm font-semibold text-primary">{topic.topic}</p><p className="text-xs text-muted mt-0.5">{topic.subjectCode} · {topic.subject}</p></td><td className="py-3 px-3"><Progress value={topic.coverage} color="bg-accent" /><p className="text-[11px] text-muted mt-1">{topic.attemptedQuestions} of {topic.totalQuestions} questions</p></td><td className="py-3 px-3">{topic.mastery == null ? <span className="text-xs text-muted">Not started</span> : <><Progress value={topic.mastery} color={topic.mastery >= 80 ? 'bg-green-500' : topic.mastery >= 50 ? 'bg-amber-500' : 'bg-red-500'} /><p className="text-[11px] text-muted mt-1">{topic.mastery}% marks · {topic.accuracy}% full answers</p></>}</td><td className="py-3 px-3 text-right text-sm font-semibold">{topic.attempts}</td></tr>)}</tbody></table></div>{filtered.length === 0 && <EmptyState icon={Target} title="No syllabus topics found" body="Import question papers or choose another subject." />}{queue.length > 0 && <section className="mt-8"><h4 className="text-sm font-bold mb-3">Recommended next</h4><div className="grid md:grid-cols-2 gap-2">{queue.slice(0, 4).map((item) => <button key={item.questionId} onClick={() => onOpenQuestion(item.questionId)} className="flex items-center gap-3 p-3 rounded-md border border-line text-left"><Target className="w-4 h-4 text-green-600 flex-none" /><div className="min-w-0"><p className="text-sm font-semibold truncate">{item.topic}</p><p className="text-xs text-muted truncate">{item.reason}</p></div><ArrowRight className="w-4 h-4 ml-auto flex-none" /></button>)}</div></section>}</main>;
}

function Progress({ value, color }: { value: number; color: string }) { return <div className="h-2 rounded-full bg-surface-raised overflow-hidden"><div className={`h-full ${color}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div>; }

function SmartSearch({ onOpenQuestion }: { onOpenQuestion: (id: number) => void }) {
  const [query, setQuery] = useState(''); const [results, setResults] = useState<SearchResult[]>([]); const [loading, setLoading] = useState(false); const [searched, setSearched] = useState(false);
  // Distinguished from "no results" so a 500 or a dropped connection doesn't
  // masquerade as "No matching material" and send the student hunting for
  // content that is actually there.
  const [searchError, setSearchError] = useState<string | null>(null);
  const search = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (query.trim().length < 2) return;
    setLoading(true); setSearched(true); setSearchError(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`);
      if (!res.ok) {
        setResults([]);
        setSearchError(res.status === 429 ? 'Too many searches — wait a moment and try again.' : 'Search is unavailable right now. Please try again.');
        return;
      }
      const data = await res.json();
      setResults(data.results ?? []);
    } catch {
      setResults([]);
      setSearchError('Could not reach the server. Check your connection and try again.');
    } finally { setLoading(false); }
  };
  const open = (result: SearchResult) => { const match = result.id.match(/^(?:question|markscheme)-(\d+)$/); if (match) onOpenQuestion(Number(match[1])); else window.open(result.url, result.type === 'resource' ? '_blank' : '_self', 'noopener,noreferrer'); };
  const typeIcon = (type: SearchResult['type']) => type === 'question' || type === 'markscheme' ? FileSearch : type === 'resource' ? BookOpen : FileSearch;
  return <main className="max-w-4xl mx-auto p-4 md:p-6"><div className="mb-5"><h3 className="font-bold text-primary">Smart search</h3><p className="text-xs text-muted mt-1">Questions, mark schemes, notes, textbook pages, synced documents, and resources</p></div><form onSubmit={search} className="relative"><Search className="absolute left-4 top-3.5 w-5 h-5 text-muted" /><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. inheritance, forces, or quadratic graphs" className="w-full h-12 pl-12 pr-28 border border-strong rounded-md bg-surface focus:outline-none focus:ring-2 focus:ring-green-500" /><button disabled={loading || query.trim().length < 2} className="absolute right-1.5 top-1.5 h-9 px-4 bg-surface-inverse text-inverse rounded-md text-sm font-semibold disabled:opacity-50">{loading ? 'Searching...' : 'Search'}</button></form><div className="mt-6 border-y border-line divide-y divide-line">{results.map((result) => { const Icon = typeIcon(result.type); return <button key={result.id} onClick={() => open(result)} className="w-full flex items-start gap-4 py-4 px-2 text-left hover:bg-surface-hover"><span className="w-9 h-9 grid place-items-center bg-surface-raised rounded-md flex-none"><Icon className="w-4 h-4" /></span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-bold text-primary">{result.title}</span><span className="text-[10px] uppercase font-bold text-green-700 dark:text-green-400">{result.type}</span></span><span className="block text-sm text-secondary line-clamp-2 mt-1">{plainTextPreview(result.snippet)}</span>{(result.subject || result.topic) && <span className="block text-xs text-muted mt-1.5">{[result.subject, result.topic].filter(Boolean).join(' · ')}</span>}</span><ArrowRight className="w-4 h-4 mt-2 text-muted flex-none" /></button>; })}</div>{searched && !loading && searchError && <EmptyState icon={AlertCircle} title="Search failed" body={searchError} />}{searched && !loading && !searchError && results.length === 0 && <EmptyState icon={Search} title="No matching material" body="Try a broader concept or a phrase from the question." />}{!searched && <div className="mt-10 text-center text-sm text-muted">Searches include your private notes only when you are signed in.</div>}</main>;
}

function ProfileEditor({ profile, onSaved }: { profile: LearningProfile | null; onSaved: () => Promise<void> }) {
  const [examDate, setExamDate] = useState(profile?.examDate?.slice(0, 10) ?? ''); const [weeklyMinutes, setWeeklyMinutes] = useState(profile?.weeklyStudyMinutes ?? 300); const [targetGrade, setTargetGrade] = useState(profile?.targetGrade ?? 'A'); const [availability, setAvailability] = useState<Record<string, number>>(profile?.availability ?? EMPTY_AVAILABILITY); const [saving, setSaving] = useState(false); const [error, setError] = useState<string | null>(null);
  const save = async (event: React.FormEvent) => { event.preventDefault(); setSaving(true); setError(null); try { const res = await fetch('/api/learning/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ examDate: examDate || null, weeklyStudyMinutes: Number(weeklyMinutes), targetGrade, availability }) }); if (!res.ok) throw new Error((await res.json()).error || 'Preferences could not be saved.'); await onSaved(); } catch (saveError) { setError(saveError instanceof Error ? saveError.message : 'Preferences could not be saved.'); } finally { setSaving(false); } };
  return <form onSubmit={save} className="border-b border-line bg-surface-raised p-4 md:px-6"><div className="max-w-7xl mx-auto"><div className="grid md:grid-cols-[160px_140px_160px_1fr_auto] gap-3 items-end"><label className="text-xs font-semibold text-secondary">Exam date<input type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)} className="mt-1 input-field" /></label><label className="text-xs font-semibold text-secondary">Target grade<input value={targetGrade} onChange={(e) => setTargetGrade(e.target.value)} maxLength={12} className="mt-1 input-field" /></label><label className="text-xs font-semibold text-secondary">Weekly minutes<input type="number" min="60" max="2520" value={weeklyMinutes} onChange={(e) => setWeeklyMinutes(Number(e.target.value))} className="mt-1 input-field" /></label><div><p className="text-xs font-semibold text-secondary mb-1">Available minutes per day</p><div className="grid grid-cols-7 gap-1">{DAYS.map((day) => <label key={day.key} className="text-[10px] text-center text-muted">{day.label}<input type="number" min="0" max="360" value={availability[day.key] ?? 0} onChange={(e) => setAvailability({ ...availability, [day.key]: Number(e.target.value) })} className="mt-1 w-full h-9 px-1 text-center border border-strong rounded-sm bg-surface text-xs" /></label>)}</div></div><button disabled={saving} className="h-10 px-4 rounded-md bg-green-600 text-white text-sm font-semibold disabled:opacity-50">{saving ? 'Saving...' : 'Save'}</button></div>{error && <p className="text-xs text-red-600 mt-2">{error}</p>}</div></form>;
}

function EmptyState({ icon: Icon, title, body }: { icon: typeof Brain; title: string; body: string }) { return <div className="py-12 px-5 text-center"><Icon className="w-8 h-8 mx-auto text-muted" /><p className="text-sm font-semibold text-primary mt-3">{title}</p><p className="text-xs text-muted mt-1 max-w-sm mx-auto">{body}</p></div>; }

// ---------------------------------------------------------------------------
// Deck browser — view all flashcards, create manually, and start review sessions
// ---------------------------------------------------------------------------
type DeckCard = {
  id: string;
  prompt: string;
  answer: string;
  subject: string;
  topic: string;
  status: string;
  nextReviewAt: string;
  intervalDays: number;
  repetitions: number;
  questionId: number | null;
};

function DeckBrowser({ onOpenQuestion }: { onOpenQuestion: (id: number) => void }) {
  const [cards, setCards] = useState<DeckCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterSubject, setFilterSubject] = useState('all');
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ prompt: '', answer: '', subject: '', topic: 'General' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/learning/reviews?mode=all');
      if (res.ok) {
        const data = await res.json();
        setCards(data.reviews ?? []);
      }
    } catch { /* best-effort */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const subjects = useMemo(() => [...new Set(cards.map((c) => c.subject))].sort(), [cards]);
  const filtered = filterSubject === 'all' ? cards : cards.filter((c) => c.subject === filterSubject);
  const dueCount = filtered.filter((c) => c.status === 'active' && new Date(c.nextReviewAt) <= new Date()).length;
  const masteredCount = filtered.filter((c) => c.status === 'mastered').length;

  const handleCreate = async () => {
    if (!createForm.prompt.trim() || !createForm.answer.trim() || !createForm.subject.trim()) return;
    try {
      const res = await fetch('/api/learning/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createForm),
      });
      if (!res.ok) {
        // Previously this branch did nothing at all: the dialog stayed open
        // with the text still in it and no indication anything had failed.
        const data = await res.json().catch(() => null);
        toast.error(data?.error ?? 'Could not create that flashcard. Please try again.');
        return;
      }
      setShowCreate(false);
      setCreateForm({ prompt: '', answer: '', subject: '', topic: 'General' });
      toast.success('Flashcard created');
      void load();
    } catch {
      toast.error('Could not reach the server. Check your connection and try again.');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch('/api/learning/reviews', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: 'archived' }),
      });
      // Only drop it from the list once the server confirms. Removing it
      // unconditionally made a failed archive look like it worked — until the
      // card reappeared on the next reload.
      if (!res.ok) {
        toast.error('Could not archive that card. Please try again.');
        return;
      }
      setCards((prev) => prev.filter((c) => c.id !== id));
    } catch {
      toast.error('Could not reach the server. Check your connection and try again.');
    }
  };

  if (loading) {
    return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted" /></div>;
  }

  return (
    <main className="max-w-4xl mx-auto p-4 md:p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h3 className="font-bold text-primary">Flashcard decks</h3>
          <p className="text-xs text-muted mt-1">{filtered.length} cards · {dueCount} due now · {masteredCount} mastered</p>
        </div>
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-white bg-accent rounded-md shadow transition-all"
        >
          <Plus className="w-4 h-4" /> New card
        </button>
      </div>

      {/* Subject filter pills */}
      {subjects.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          <button
            onClick={() => setFilterSubject('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${filterSubject === 'all' ? 'bg-surface-inverse text-inverse' : 'bg-surface-raised text-secondary hover:bg-surface-active'}`}
          >
            All ({cards.length})
          </button>
          {subjects.map((s) => (
            <button
              key={s}
              onClick={() => setFilterSubject(s)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${filterSubject === s ? 'bg-surface-inverse text-inverse' : 'bg-surface-raised text-secondary hover:bg-surface-active'}`}
            >
              {s} ({cards.filter((c) => c.subject === s).length})
            </button>
          ))}
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="mb-4 p-4 bg-surface border border-line rounded-lg space-y-3">
          <h4 className="text-sm font-bold text-primary">New flashcard</h4>
          <input
            value={createForm.subject}
            onChange={(e) => setCreateForm({ ...createForm, subject: e.target.value })}
            placeholder="Subject (e.g. Physics)"
            className="w-full px-3 py-2 text-sm border border-strong rounded-md bg-surface"
          />
          <input
            value={createForm.topic}
            onChange={(e) => setCreateForm({ ...createForm, topic: e.target.value })}
            placeholder="Topic (e.g. Mechanics)"
            className="w-full px-3 py-2 text-sm border border-strong rounded-md bg-surface"
          />
          <textarea
            value={createForm.prompt}
            onChange={(e) => setCreateForm({ ...createForm, prompt: e.target.value })}
            placeholder="Front: question or prompt"
            rows={3}
            className="w-full px-3 py-2 text-sm border border-strong rounded-md bg-surface"
          />
          <textarea
            value={createForm.answer}
            onChange={(e) => setCreateForm({ ...createForm, answer: e.target.value })}
            placeholder="Back: answer or explanation"
            rows={3}
            className="w-full px-3 py-2 text-sm border border-strong rounded-md bg-surface"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-xs font-medium text-secondary bg-surface-raised rounded-md hover:bg-surface-active">Cancel</button>
            <button
              onClick={handleCreate}
              disabled={!createForm.prompt.trim() || !createForm.answer.trim() || !createForm.subject.trim()}
              className="px-3 py-1.5 text-xs font-semibold text-white bg-green-600 rounded-md disabled:opacity-50"
            >
              Create card
            </button>
          </div>
        </div>
      )}

      {/* Card list */}
      {filtered.length === 0 ? (
        <EmptyState icon={Layers} title="No flashcards yet" body="Create cards manually, or they're auto-created from wrong practice answers." />
      ) : (
        <div className="space-y-2">
          {filtered.map((card) => {
            const isDue = card.status === 'active' && new Date(card.nextReviewAt) <= new Date();
            return (
              <div key={card.id} className={`p-4 bg-surface border rounded-lg ${isDue ? 'border-amber-300 dark:border-amber-700' : 'border-line'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-bold uppercase text-muted">{card.subject}</span>
                      <span className="text-[10px] text-muted">· {card.topic}</span>
                      {card.status === 'mastered' && <span className="text-[10px] font-bold text-green-600">✓ mastered</span>}
                      {isDue && <span className="text-[10px] font-bold text-amber-600">due now</span>}
                    </div>
                    <p className="text-sm font-semibold text-primary line-clamp-2">{plainTextPreview(card.prompt)}</p>
                    <p className="text-xs text-muted mt-1 line-clamp-1">{plainTextPreview(card.answer)}</p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {card.questionId && (
                      <button
                        onClick={() => card.questionId && onOpenQuestion(card.questionId)}
                        className="p-1.5 text-muted hover:text-emerald-600 rounded-sm transition-colors"
                        title="Open source question" aria-label="Open source question"
                      >
                        <BookOpen className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(card.id)}
                      className="p-1.5 text-muted hover:text-red-600 rounded-sm transition-colors"
                      title="Archive card" aria-label="Archive card"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
