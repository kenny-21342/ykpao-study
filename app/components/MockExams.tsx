'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import NoticeDialog from './NoticeDialog';
import PreviewNotice from './PreviewNotice';
import toast from 'react-hot-toast';
import {
  ClipboardList, Plus, Clock, Award, Trash2, Play, ArrowRight, ArrowLeft,
  CheckCircle2, XCircle, Sparkles, FileText, ChevronRight, Loader2, AlertCircle,
  Trophy, Target, BookOpen, RefreshCw, Eye, X, Lightbulb, Flag,
  Image as ImageIcon, Upload,
} from 'lucide-react';

/*
 * next/image is deliberately not used for the crops below.
 *
 * They are session-gated strips served from /bank_assets/**, which the image
 * optimiser would fetch server-side without the viewer's cookie and get a 401
 * for. They are also already rendered at a fixed 200 DPI, so re-encoding buys
 * nothing.
 */
/* eslint-disable @next/next/no-img-element */

const FormattedMessage = dynamic(() => import('./FormattedMessage'), { ssr: false });

/**
 * A question or mark scheme, however it is stored.
 *
 * Papers built from the crop-first bank carry strip images and an empty
 * `content`; papers from the older transcribed corpus carry text and no strips.
 * Rendering `content` alone showed a blank card for every question on a
 * bank-built paper, so the images come first and prose is the fallback.
 */
function ExamContent({
  content,
  strips,
  alt,
}: {
  content: string | null;
  strips?: Array<{ url: string; width: number | null; height: number | null }>;
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
            className="block max-w-full bg-white"
          />
        ))}
      </div>
    );
  }
  if (!content) return null;
  return <FormattedMessage content={content} />;
}
const RichTextEditor = dynamic(() => import('./RichTextEditor'), { ssr: false });

// ----------------------------- Types -----------------------------
type ExamStatus = 'generating' | 'generated' | 'failed' | 'in_progress' | 'completed';

type ExamListItem = {
  id: string;
  title: string;
  description: string | null;
  subjectCode: string | null;
  durationMinutes: number;
  totalMarks: number;
  difficulty: string;
  topics: string[];
  status: ExamStatus;
  /** Set only when status is 'failed'; shown in place of a dead Start button. */
  generationError?: string | null;
  score: number | null;
  questionCount: number;
  createdAt: string;
  submittedAt: string | null;
};

type ExamItem = {
  id: string;
  sectionTitle: string;
  order: number;
  questionId: number;
  number: number;
  part: string;
  subPart: string;
  content: string;
  latex: string | null;
  marks: number;
  markschemeContent: string | null;
  // A question drawn from the crop-first bank has no transcript: it *is* the
  // image. Empty for the older transcribed corpus, which has text and no crop.
  strips?: Array<{ url: string; width: number | null; height: number | null }>;
  markschemeStrips?: Array<{ url: string; width: number | null; height: number | null }>;
  answerLetter?: string | null;
  answer: string | null;
  score: number | null;
  isCorrect: boolean | null;
  explanation: string | null;
  modelAnswer: string | null;
  strengths: string[];
  weaknesses: string[];
  attemptedAt: string | null;
};

type ExamDetail = {
  id: string;
  title: string;
  description: string | null;
  subjectCode: string | null;
  durationMinutes: number;
  totalMarks: number;
  difficulty: string;
  topics: string[];
  status: ExamStatus;
  /** Set only when status is 'failed'. */
  generationError?: string | null;
  score: number | null;
  startedAt: string | null;
  submittedAt: string | null;
  createdAt: string;
  items: ExamItem[];
};

type Subject = {
  id: number;
  code: string;
  name: string;
  /**
   * Whether a predicted paper for this subject is curated by a model reading
   * question text, or assembled from the crop-first bank. Topics and
   * Difficulty only reach the first kind.
   */
  curatedPrediction?: boolean;
};

type View =
  | { name: 'list' }
  | { name: 'configure' }
  | { name: 'take'; examId: string }
  | { name: 'results'; examId: string };

// ----------------------------- Helpers -----------------------------
const STATUS_META: Record<ExamStatus, { label: string; cls: string }> = {
  generating: {
    label: 'Building…',
    cls: 'bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-700',
  },
  failed: {
    label: 'Failed',
    cls: 'bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800',
  },
  generated: {
    label: 'Ready',
    cls: 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800',
  },
  in_progress: {
    label: 'In Progress',
    cls: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  },
  completed: {
    label: 'Completed',
    cls: 'bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800',
  },
};

const DIFFICULTY_OPTIONS = ['mixed', 'easy', 'medium', 'hard'] as const;

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTime(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// ===================================================================
// Component
// ===================================================================
export default function MockExams() {
  const [view, setView] = useState<View>({ name: 'list' });
  const [exams, setExams] = useState<ExamListItem[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title: string; message: string; tone?: 'info' | 'success' | 'warning' | 'error' } | null>(null);

  const refreshList = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const res = await fetch('/api/mock-exams?page=1&limit=50');
      if (!res.ok) throw new Error('Failed to load exams');
      const data = await res.json();
      setExams(data.exams ?? []);
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Failed to load exams');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (view.name === 'list') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refreshList();
    }
  }, [view, refreshList]);

  const handleGenerated = (examId: string) => setView({ name: 'take', examId });
  const handleViewResults = (examId: string) => setView({ name: 'results', examId });
  const handleBackToList = () => setView({ name: 'list' });

  // --------------------------- Render ---------------------------
  if (view.name === 'configure') {
    return (
      <ConfigureView
        onCancel={handleBackToList}
        onGenerated={handleGenerated}
      />
    );
  }

  if (view.name === 'take') {
    return (
      <TakeExamView
        examId={view.examId}
        onExit={handleBackToList}
        onSubmitted={(id) => setView({ name: 'results', examId: id })}
      />
    );
  }

  if (view.name === 'results') {
    return (
      <ResultsView
        examId={view.examId}
        onExit={handleBackToList}
        onRetake={() => setView({ name: 'configure' })}
      />
    );
  }

  // ---- LIST VIEW ----
  return (
    <div className="h-full overflow-y-auto p-6 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <PreviewNotice feature="mock-exams" />
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
              <ClipboardList className="w-6 h-6 text-green-600" />
              Mock Exams
            </h2>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              Build a paper from the question bank, sit it under timed conditions, and
              get multiple-choice answers marked the moment you submit.
            </p>
          </div>
          <button
            onClick={() => setView({ name: 'configure' })}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-green-500 to-emerald-500 text-white rounded-xl font-semibold shadow-lg shadow-green-500/25 hover:shadow-green-500/40 transition-all"
          >
            <Plus className="w-5 h-5" />
            New Mock Exam
          </button>
        </div>

        {/* Stats summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            icon={<ClipboardList className="w-5 h-5" />}
            label="Total Exams"
            value={exams.length}
            tint="blue"
          />
          <StatCard
            icon={<Trophy className="w-5 h-5" />}
            label="Completed"
            value={exams.filter((e) => e.status === 'completed').length}
            tint="green"
          />
          <StatCard
            icon={<Clock className="w-5 h-5" />}
            label="In Progress"
            value={exams.filter((e) => e.status === 'in_progress').length}
            tint="amber"
          />
          <StatCard
            icon={<Award className="w-5 h-5" />}
            label="Avg Score"
            value={
              exams.filter((e) => e.status === 'completed').length === 0
                ? '—'
                : `${Math.round(
                    exams
                      .filter((e) => e.status === 'completed' && e.score !== null)
                      .reduce((acc, e, _i, arr) => acc + (e.score ?? 0) / (e.totalMarks || 1) / arr.length * 100, 0)
                  )}%`
            }
            tint="purple"
          />
        </div>

        {/* List */}
        {loadingList && exams.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-gray-500">
            <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading exams…
          </div>
        ) : listError ? (
          <ErrorBanner message={listError} onRetry={refreshList} />
        ) : exams.length === 0 ? (
          <EmptyState onCreate={() => setView({ name: 'configure' })} />
        ) : (
          <div className="grid gap-4">
            {exams.map((exam) => (
              <ExamCard
                key={exam.id}
                exam={exam}
                onDelete={async () => {
                  if (!confirm('Delete this mock exam? This cannot be undone.')) return;
                  try {
                    const res = await fetch(`/api/mock-exams/${exam.id}`, { method: 'DELETE' });
                  if (!res.ok) throw new Error('Failed to delete');
                  refreshList();
                } catch (e) {
                    setNotice({
                      title: 'Delete failed',
                      message: e instanceof Error ? e.message : 'The mock exam could not be deleted.',
                      tone: 'error',
                    });
                }
              }}
                onOpen={() => {
                  if (exam.status === 'completed') handleViewResults(exam.id);
                  else setView({ name: 'take', examId: exam.id });
                }}
                onViewResults={() => handleViewResults(exam.id)}
              />
            ))}
          </div>
        )}

        <NoticeDialog
          open={notice !== null}
          title={notice?.title ?? ''}
          message={notice?.message ?? ''}
          tone={notice?.tone ?? 'info'}
          onClose={() => setNotice(null)}
        />
      </div>
    </div>
  );
}

// --------------------------- Subcomponents: list ---------------------------
function StatCard({
  icon, label, value, tint,
}: { icon: React.ReactNode; label: string; value: string | number; tint: 'blue' | 'green' | 'amber' | 'purple' }) {
  const tints: Record<string, string> = {
    blue: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300',
    green: 'bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-300',
    amber: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-300',
    purple: 'bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-300',
  };
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 border border-gray-200 dark:border-gray-700 shadow-sm">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-3 ${tints[tint]}`}>
        {icon}
      </div>
      <p className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mt-0.5">{label}</p>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl border border-dashed border-gray-300 dark:border-gray-600 p-12 text-center">
      <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-green-500 to-emerald-500 flex items-center justify-center shadow-lg shadow-green-500/30 mb-4">
        <Sparkles className="w-8 h-8 text-white" />
      </div>
      <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">No mock exams yet</h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-md mx-auto">
        Create your first mock exam. Pick a subject and a mark total —
        we&apos;ll assemble a paper from real past-paper questions.
      </p>
      <button
        onClick={onCreate}
        className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-green-500 to-emerald-500 text-white rounded-xl font-semibold shadow-lg shadow-green-500/25 hover:shadow-green-500/40 transition-all"
      >
        <Plus className="w-5 h-5" /> Generate a Mock Exam
      </button>
    </div>
  );
}

function ExamCard({
  exam, onOpen, onViewResults, onDelete,
}: {
  exam: ExamListItem;
  onOpen: () => void;
  onViewResults: () => void;
  onDelete: () => void;
}) {
  const meta = STATUS_META[exam.status];
  const pct =
    exam.status === 'completed' && exam.score !== null && exam.totalMarks > 0
      ? Math.round((exam.score / exam.totalMarks) * 100)
      : null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm hover:shadow-md transition-shadow p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100 truncate">
              {exam.title}
            </h3>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${meta.cls}`}>
              {meta.label}
            </span>
          </div>
          {exam.description && exam.status !== 'failed' && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">
              {exam.description}
            </p>
          )}
          <div className="flex items-center gap-4 mt-3 text-xs text-gray-500 dark:text-gray-400 flex-wrap">
            {exam.subjectCode && (
              <span className="inline-flex items-center gap-1">
                <BookOpen className="w-3.5 h-3.5" /> {exam.subjectCode}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <FileText className="w-3.5 h-3.5" /> {exam.questionCount} questions
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" /> {exam.durationMinutes} min
            </span>
            <span className="inline-flex items-center gap-1">
              <Target className="w-3.5 h-3.5" /> {exam.totalMarks} marks
            </span>
            <span>Created {fmtDate(exam.createdAt)}</span>
          </div>
        </div>

        <div className="flex flex-col items-end gap-2">
          {pct !== null && (
            <div className="text-right">
              <div className={`text-2xl font-bold ${pct >= 70 ? 'text-green-600' : pct >= 40 ? 'text-amber-600' : 'text-red-600'}`}>
                {pct}%
              </div>
              <div className="text-xs text-gray-500">
                {Math.round(exam.score ?? 0)} / {exam.totalMarks}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
        <div className="flex items-center gap-2">
          {exam.topics.slice(0, 3).map((t) => (
            <span key={t} className="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-md">
              {t}
            </span>
          ))}
          {exam.topics.length > 3 && (
            <span className="text-xs text-gray-400">+{exam.topics.length - 3}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {exam.status === 'completed' && (
            <button
              onClick={onViewResults}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
            >
              <Eye className="w-4 h-4" /> Review
            </button>
          )}
          <button
            onClick={onDelete}
            className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          {/* A paper that failed to generate has no questions on it, so Start
              leads to an error page. Say what went wrong instead of offering a
              button that cannot work. */}
          {exam.status === 'failed' ? (
            <span className="text-xs text-red-600 dark:text-red-400 max-w-xs text-right">
              {exam.generationError ?? 'This paper could not be generated.'}
            </span>
          ) : exam.status === 'generating' ? (
            <span className="text-xs text-gray-500 dark:text-gray-400">Still building…</span>
          ) : exam.status !== 'completed' ? (
            <button
              onClick={onOpen}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-500 rounded-lg shadow hover:shadow-md transition-all"
            >
              <Play className="w-4 h-4" />
              {exam.status === 'in_progress' ? 'Resume' : 'Start'}
            </button>
          ) : (
            <button
              onClick={onViewResults}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-500 rounded-lg shadow hover:shadow-md transition-all"
            >
              View Results <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-2xl p-5 flex items-start gap-3">
      <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="text-sm font-semibold text-red-800 dark:text-red-300">{message}</p>
        {onRetry && (
          <button onClick={onRetry} className="mt-2 text-sm text-red-700 underline">
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

// ===================================================================
// Configure / Generate wizard
// ===================================================================
function ConfigureView({ onCancel, onGenerated }: { onCancel: () => void; onGenerated: (id: string) => void }) {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loadingFilters, setLoadingFilters] = useState(true);

  const [mode, setMode] = useState<'mock' | 'predicted'>('mock');
  const [subjectCode, setSubjectCode] = useState('');
  const [difficulty, setDifficulty] = useState<string>('mixed');
  const [totalMarks, setTotalMarks] = useState(50);
  const [durationMinutes, setDurationMinutes] = useState(90);
  const [topicsRaw, setTopicsRaw] = useState('');
  const [title, setTitle] = useState('');

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Only the subjects generation can actually serve — see
        // app/api/mock-exams/subjects/route.ts. The old source listed every
        // subject with a paper, which is how 0606 got offered and then refused.
        const res = await fetch('/api/mock-exams/subjects');
        if (!res.ok) throw new Error('Failed to load subjects');
        const data = await res.json();
        if (cancelled) return;
        setSubjects(data.subjects ?? []);
        if (data.subjects?.length && !subjectCode) {
          setSubjectCode(data.subjects[0].code);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load subjects');
      } finally {
        if (!cancelled) setLoadingFilters(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canGenerate = !!subjectCode && !generating;

  // Controls that only the model-curated path can act on. For a bank-backed
  // subject the paper is drawn by query over image crops, with no topic table
  // and no difficulty tagging, so these would be inert.
  const curatedPrediction =
    subjects.find((s) => s.code === subjectCode)?.curatedPrediction ?? false;
  const showPredictionSteering = mode === 'predicted' && curatedPrediction;

  const handleGenerate = async () => {
    if (!subjectCode) return;
    setGenerating(true);
    setError(null);
    const topics = topicsRaw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      const res = await fetch('/api/mock-exams/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectCode,
          topics,
          totalMarks,
          durationMinutes,
          difficulty,
          title: title.trim() || undefined,
          mode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate exam');
      onGenerated(data.exam.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to generate exam');
      setGenerating(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={onCancel}
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Generate a Mock Exam</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {mode === 'predicted'
                ? curatedPrediction
                  ? 'A paper shaped after the structure of your subject\u2019s real past papers, with the questions chosen for you.'
                  : 'A paper shaped after the structure of your subject\u2019s real past papers \u2014 same mark total, same length, same spread of question sizes.'
                : 'Questions are drawn from the bank to match your mark total. No wait \u2014 the paper is ready as soon as you press the button.'}
            </p>
          </div>
        </div>

        <PreviewNotice feature="mock-exams" />

        {/* Wizard steps indicator */}
        <div className="flex items-center gap-2 text-sm">
          <StepDot n={1} label="Configure" active />
          <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
          <StepDot n={2} label="Generate" />
          <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
          <StepDot n={3} label="Take Exam" />
        </div>

        {/* Form card */}
        <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-6 space-y-5">
          {loadingFilters ? (
            <div className="flex items-center justify-center py-10 text-gray-500">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading subjects…
            </div>
          ) : (
            <>
              <Field label="Paper type">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setMode('mock')}
                    className={`px-3 py-2 text-sm font-medium rounded-xl border transition-all ${
                      mode === 'mock'
                        ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white border-transparent shadow'
                        : 'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:border-green-400'
                    }`}
                  >
                    Mock exam
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('predicted')}
                    className={`px-3 py-2 text-sm font-medium rounded-xl border transition-all ${
                      mode === 'predicted'
                        ? 'bg-gradient-to-r from-fuchsia-500 to-violet-500 text-white border-transparent shadow'
                        : 'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:border-fuchsia-400'
                    }`}
                  >
                    Predicted paper
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-1">
                  Predicted papers use the question bank plus observed paper structure and mark schemes.
                </p>
              </Field>

              <Field label="Exam title (optional)">
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Paper 2 mechanics refresher"
                  className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
                />
              </Field>

              <Field label="Subject" required>
                {subjects.length === 0 ? (
                  // Rather than an empty dropdown above a dead button. This is
                  // reachable: a student may be enrolled only in subjects whose
                  // mark schemes have not been linked yet.
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    None of your subjects have marked questions in the bank yet, so a
                    paper cannot be assembled. Browse the question bank in Practice
                    in the meantime.
                  </p>
                ) : (
                  <select
                    value={subjectCode}
                    onChange={(e) => setSubjectCode(e.target.value)}
                    className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
                  >
                    {subjects.map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.name} ({s.code})
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              {/* No published bank question carries a difficulty and no bank
                  topic has been tagged at all, so neither control can steer a
                  paper assembled by query -- it would sit there looking like it
                  worked. Only a model-curated prediction, which reads the
                  legacy corpus's question text, can act on them. Both come back
                  for everything once the tagging pass has run. */}
              {showPredictionSteering && (
              <Field label="Difficulty">
                <div className="grid grid-cols-4 gap-2">
                  {DIFFICULTY_OPTIONS.map((d) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDifficulty(d)}
                      className={`px-3 py-2 text-sm font-medium rounded-xl border transition-all capitalize ${
                        difficulty === d
                          ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white border-transparent shadow'
                          : 'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:border-green-400'
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </Field>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <Field label={`Total marks: ${totalMarks}`}>
                  <input
                    type="range"
                    min={20}
                    max={120}
                    step={10}
                    value={totalMarks}
                    onChange={(e) => setTotalMarks(Number(e.target.value))}
                    className="w-full accent-green-600"
                  />
                  <div className="flex justify-between text-xs text-gray-400 mt-1">
                    <span>20</span><span>120</span>
                  </div>
                </Field>

                <Field label={`Duration: ${durationMinutes} min`}>
                  <input
                    type="range"
                    min={30}
                    max={180}
                    step={15}
                    value={durationMinutes}
                    onChange={(e) => setDurationMinutes(Number(e.target.value))}
                    className="w-full accent-green-600"
                  />
                  <div className="flex justify-between text-xs text-gray-400 mt-1">
                    <span>30m</span><span>3h</span>
                  </div>
                </Field>
              </div>

              {showPredictionSteering && (
                <Field label="Topics (comma-separated, optional)">
                  <input
                    type="text"
                    value={topicsRaw}
                    onChange={(e) => setTopicsRaw(e.target.value)}
                    placeholder="e.g. kinematics, forces, momentum"
                    className="w-full px-3 py-2.5 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-green-500 focus:border-transparent outline-none"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    Leave blank to sample across the whole subject.
                  </p>
                </Field>
              )}
            </>
          )}
        </div>

        {error && <ErrorBanner message={error} />}

        {/* Footer actions */}
        <div className="flex items-center justify-between gap-3">
          <button
            onClick={onCancel}
            disabled={generating}
            className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-xl transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-500 rounded-xl shadow-lg shadow-green-500/25 hover:shadow-green-500/40 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {generating ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" /> Generating…
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" /> {mode === 'predicted' ? 'Generate Predicted Paper' : 'Generate Exam'}
              </>
            )}
          </button>
        </div>

        {generating && (
          <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-2xl p-4 text-sm text-green-800 dark:text-green-300 flex items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin flex-shrink-0" />
            <span>
              {mode === 'predicted' && curatedPrediction
                ? 'Reading your subject\u2019s past papers, choosing questions, and writing the marking guidance. This usually takes 10\u201330 seconds.'
                : 'Measuring your subject\u2019s past papers and drawing questions to match.'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {children}
    </label>
  );
}

function StepDot({ n, label, active, done }: { n: number; label: string; active?: boolean; done?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
        done
          ? 'bg-green-500 text-white'
          : active
            ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white shadow'
            : 'bg-gray-200 dark:bg-gray-700 text-gray-500'
      }`}>
        {done ? <CheckCircle2 className="w-4 h-4" /> : n}
      </div>
      <span className={`text-xs font-medium ${active ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400'}`}>
        {label}
      </span>
    </div>
  );
}
// ===================================================================
// Take Exam view (timer + per-question answer inputs)
// ===================================================================
function TakeExamView({ examId, onExit, onSubmitted }: { examId: string; onExit: () => void; onSubmitted: (id: string) => void }) {
  const [exam, setExam] = useState<ExamDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [images, setImages] = useState<Record<string, string>>({});
  const [ocrLoading, setOcrLoading] = useState<string | null>(null); // itemId being transcribed
  const [flagged, setFlagged] = useState<Record<string, boolean>>({});
  const [activeIdx, setActiveIdx] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const startedRef = useRef(false);
  // Wall-clock instant the paper is due, derived from the server's `startedAt`.
  // The countdown reads this rather than decrementing a counter: a background
  // tab has its timers throttled and a stalled renderer stops them outright,
  // both of which silently hand the candidate extra time.
  const deadlineRef = useRef<number | null>(null);
  const submittedRef = useRef(false);
  // Keep a ref to the latest answers so the auto-save interval + beforeunload
  // handlers can read current state without re-subscribing on every keystroke.
  const latestAnswers = useRef<Record<string, string>>({});
  latestAnswers.current = answers;

  // Load exam detail, re-polling while the paper is still being built.
  //
  // Generation is asynchronous: POST /generate answers 202 with the paper row
  // created but empty, then fills in the questions in the background. Reading
  // once would show a paper with no questions and start its timer against it.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Comfortably past the server's own 50s selection budget, so a paper is
    // only called stuck once the server has certainly stopped working on it.
    const deadline = Date.now() + 90_000;

    const load = async () => {
      try {
        const res = await fetch(`/api/mock-exams/${examId}`);
        if (!res.ok) throw new Error('Failed to load exam');
        const data = await res.json();
        if (cancelled) return;
        const detail: ExamDetail = data.exam;
        setExam(detail);
        setLoading(false);

        if (detail.status === 'generating') {
          if (Date.now() > deadline) {
            setError('This paper is taking longer than expected. Try generating it again.');
            return;
          }
          timer = setTimeout(load, 2_000);
          return;
        }

        if (detail.status === 'failed') {
          setError(detail.generationError ?? 'Generating this paper failed. Please try again.');
          return;
        }

        // Resume against when the exam actually started, not when this tab
        // loaded it. Seeding the full duration on every load meant a reload
        // returned the whole paper's time, so the limit was unenforceable.
        const startedAt = detail.startedAt ? Date.parse(detail.startedAt) : NaN;
        const startedMs = Number.isFinite(startedAt) ? startedAt : Date.now();
        deadlineRef.current = startedMs + detail.durationMinutes * 60_000;
        setSecondsLeft(Math.max(0, Math.round((deadlineRef.current - Date.now()) / 1000)));
        // Pre-fill any existing answers
        const existing: Record<string, string> = {};
        for (const item of detail.items) {
          if (item.answer) existing[item.id] = item.answer;
        }
        setAnswers(existing);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load exam');
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [examId]);

  // Start the exam once (server-side marker)
  useEffect(() => {
    // Not while the questions are still being chosen, and not for a paper that
    // failed to generate -- starting either would run the clock on nothing.
    if (!exam || exam.status === 'generating' || exam.status === 'failed') return;
    if (startedRef.current) return;
    startedRef.current = true;
    fetch(`/api/mock-exams/${examId}/start`, { method: 'POST' }).catch(() => {});
  }, [exam, examId]);

  // Countdown timer
  useEffect(() => {
    if (secondsLeft === null || submitting) return;
    if (secondsLeft <= 0) {
      handleSubmit();
      return;
    }
    const t = setTimeout(() => {
      const deadline = deadlineRef.current;
      if (deadline === null) return;
      setSecondsLeft(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    }, 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft, submitting]);

  const answeredCount = exam ? exam.items.filter((i) => (answers[i.id] ?? '').trim()).length : 0;
  const flaggedCount = exam ? exam.items.filter((i) => flagged[i.id]).length : 0;

  // Persist in-progress answers to the server so a dropped tab/device can
  // resume. Debounced — fires 5s after the last keystroke, then every 60s.
  const saveProgress = useCallback(async (signal?: AbortSignal) => {
    try {
      setSaving(true);
      const res = await fetch(`/api/mock-exams/${examId}/progress`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: latestAnswers.current }),
        signal,
      });
      if (res.ok) setLastSavedAt(Date.now());
    } catch {
      // best-effort
    } finally {
      setSaving(false);
    }
  }, [examId]);

  // Auto-save: 5s after answers change (debounced) + every 60s.
  useEffect(() => {
    if (!exam) return;
    const debounce = setTimeout(() => saveProgress(), 5000);
    const interval = setInterval(() => saveProgress(), 60_000);
    return () => { clearTimeout(debounce); clearInterval(interval); };
  }, [answers, exam, saveProgress]);

  // Save on tab close / navigation (best-effort, fire-and-forget).
  useEffect(() => {
    const onHide = () => {
      const payload = JSON.stringify({ answers: latestAnswers.current });
      // sendBeacon can't set headers, so we fire a normal fetch in
      // keepalive mode which the browser will complete after unload.
      fetch(`/api/mock-exams/${examId}/progress`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [examId]);

  async function handleSubmit() {
    if (submittedRef.current || !exam) return;
    submittedRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/mock-exams/${examId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers, images }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit exam');
      onSubmitted(examId);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Failed to submit exam');
      setSubmitting(false);
      submittedRef.current = false;
    }
  }

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading exam…
      </div>
    );
  }
  if (error || !exam) {
    return (
      <div className="h-full p-8">
        <ErrorBanner message={error ?? 'Exam not found'} onRetry={onExit} />
      </div>
    );
  }

  if (exam.status === 'generating') {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
        <Loader2 className="w-7 h-7 animate-spin text-green-600" />
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">Building your paper…</p>
        <p className="max-w-sm text-sm text-gray-600 dark:text-gray-400">
          Choosing questions from the bank. This usually takes under a minute, and
          the timer does not start until the paper is ready.
        </p>
        <button
          onClick={onExit}
          className="mt-2 rounded-xl border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
        >
          Back to exams
        </button>
      </div>
    );
  }

  const item = exam.items[activeIdx];
  const totalItems = exam.items.length;
  const timeLow = secondsLeft !== null && secondsLeft < 300;

  const handleImageUpload = async (itemId: string, file: File) => {
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.fileUrl) throw new Error(data.error || 'Upload failed');
      setImages((prev) => ({ ...prev, [itemId]: data.fileUrl }));
      toast.success('Photo attached');
    } catch (uploadError) {
      // Swallowing this mid-exam was the worst case in the app: the student
      // photographs their working, nothing appears, and they have no idea
      // whether it was saved.
      toast.error(
        uploadError instanceof Error && uploadError.message
          ? `Photo upload failed: ${uploadError.message}`
          : 'Photo upload failed. Your typed answer is still saved — try again or type your working.',
      );
    }
  };

  const transcribeAnswer = async (itemId: string) => {
    const imageUrl = images[itemId];
    if (!imageUrl) return;
    setOcrLoading(itemId);
    try {
      const res = await fetch('/api/practice/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Transcription failed');
      const transcript = (data.text || '').trim();
      if (transcript) {
        setAnswers((prev) => {
          const existing = prev[itemId]?.trim() ?? '';
          const stamp = '\n\n[Transcribed from handwritten work]\n';
          return { ...prev, [itemId]: existing ? `${existing}${stamp}${transcript}` : transcript };
        });
      } else {
        // A successful call that read nothing is not the same as a failure,
        // but it still needs saying — otherwise the button just does nothing.
        toast('Nothing readable was found in that photo. Try a clearer, straighter shot.');
      }
    } catch (ocrError) {
      toast.error(
        ocrError instanceof Error && ocrError.message
          ? `Transcription failed: ${ocrError.message}`
          : 'Transcription failed. Your photo is still attached — you can type your answer instead.',
      );
    }
    setOcrLoading(null);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Exam top bar: title, timer, progress */}
      <div className="px-6 py-3 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={async () => {
              if (!confirm('Leave the exam? Your answers are saved and you can resume later — the timer keeps running.')) return;
              await saveProgress();
              onExit();
            }}
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            title="Save & exit exam"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100 truncate">{exam.title}</h2>
            <p className="text-xs text-gray-500">
              {exam.subjectCode ?? 'Exam'} • {totalItems} questions • {exam.totalMarks} marks
            </p>
            {exam.description && (
              <p className="text-[11px] text-gray-400 mt-1 line-clamp-2">{exam.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl font-mono text-sm font-semibold ${
            timeLow
              ? 'bg-red-50 text-red-700 border border-red-200 animate-pulse'
              : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200'
          }`}>
            <Clock className="w-4 h-4" />
            {secondsLeft !== null ? fmtTime(secondsLeft) : '—'}
          </div>
          <span className="text-xs text-gray-500 hidden md:inline">
            {answeredCount}/{totalItems} answered
            {flaggedCount > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <Flag className="w-3 h-3" /> {flaggedCount} flagged
              </span>
            )}
          </span>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Question navigator sidebar */}
        <aside className="w-14 md:w-48 bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-700 overflow-y-auto p-2 flex-shrink-0">
          <p className="hidden md:block text-xs font-semibold text-gray-400 uppercase px-2 py-2">Questions</p>
          <div className="grid grid-cols-1 gap-1">
            {exam.items.map((it, idx) => {
              const answered = !!(answers[it.id] ?? '').trim();
              const isFlagged = !!flagged[it.id];
              return (
                <button
                  key={it.id}
                  onClick={() => setActiveIdx(idx)}
                  className={`flex items-center gap-2 px-2 py-2 rounded-lg text-sm transition-colors ${
                    idx === activeIdx
                      ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white font-semibold'
                      : answered
                        ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800'
                  }`}
                  title={`Q${it.number}${it.part || ''}${it.subPart || ''}${isFlagged ? ' (flagged for review)' : ''}`}
                >
                  <span className="w-6 text-center font-mono text-xs flex-shrink-0">
                    {idx + 1}
                  </span>
                  {answered && idx !== activeIdx && <CheckCircle2 className="w-3 h-3 hidden md:block" />}
                  {isFlagged && (
                    <Flag className={`w-3 h-3 flex-shrink-0 ${idx === activeIdx ? 'text-white' : 'text-amber-500'}`} fill="currentColor" />
                  )}
                  <span className="hidden md:inline truncate">
                    Q{it.number}{it.part || ''}{it.subPart || ''}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* Question + answer area */}
        <div className="flex-1 overflow-y-auto p-6 md:p-8">
          <div className="max-w-3xl mx-auto space-y-5">
            {/* Question header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 rounded-md">
                  {item.sectionTitle}
                </span>
                <span className="text-sm font-bold text-gray-900 dark:text-gray-100">
                  Question {activeIdx + 1} of {totalItems}
                </span>
                <span className="text-xs text-gray-500">
                  Q{item.number}{item.part || ''}{item.subPart || ''}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold px-2 py-1 bg-amber-50 text-amber-700 border border-amber-200 rounded-md">
                  [{item.marks} marks]
                </span>
                <button
                  type="button"
                  onClick={() => setFlagged((f) => ({ ...f, [item.id]: !f[item.id] }))}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md border transition-colors ${
                    flagged[item.id]
                      ? 'bg-amber-500 text-white border-amber-500 hover:bg-amber-600'
                      : 'bg-white dark:bg-gray-800 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800 hover:bg-amber-50 dark:hover:bg-amber-900/20'
                  }`}
                  title={flagged[item.id] ? 'Remove review flag' : 'Mark for review'}
                >
                  <Flag className="w-3.5 h-3.5" fill={flagged[item.id] ? 'currentColor' : 'none'} />
                  {flagged[item.id] ? 'Flagged' : 'Mark for review'}
                </button>
              </div>
            </div>

            {/* Question content */}
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl p-5">
              <div className="prose prose-sm max-w-none text-gray-900 dark:text-gray-100">
                <ExamContent
                  content={item.content}
                  strips={item.strips}
                  alt={`Question ${item.number}`}
                />
              </div>
            </div>

            {/* Answer area */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Your answer
                </label>
                <div className="flex items-center gap-2">
                  {images[item.id] && (
                    <button
                      onClick={() => transcribeAnswer(item.id)}
                      disabled={ocrLoading === item.id}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-60 transition-all"
                    >
                      {ocrLoading === item.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lightbulb className="w-3.5 h-3.5" />}
                      {ocrLoading === item.id ? 'Transcribing…' : 'Transcribe'}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      const input = document.createElement('input');
                      input.type = 'file';
                      input.accept = 'image/*';
                      input.onchange = (e) => {
                        const f = (e.target as HTMLInputElement).files?.[0];
                        if (f) void handleImageUpload(item.id, f);
                      };
                      input.click();
                    }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-all"
                  >
                    <ImageIcon className="w-3.5 h-3.5" /> Upload photo
                  </button>
                </div>
              </div>
              {images[item.id] && (
                <div className="mb-2 flex items-center gap-2 p-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                  <img src={images[item.id]} alt="Uploaded answer" className="w-12 h-12 object-cover rounded border border-gray-200 dark:border-gray-700" />
                  <span className="text-xs text-gray-500 flex-1">Photo attached — transcribe or submit as-is.</span>
                  <button onClick={() => setImages((prev) => { const next = { ...prev }; delete next[item.id]; return next; })} className="text-xs font-medium text-red-600 hover:text-red-700">Remove</button>
                </div>
              )}
              <RichTextEditor
                content={answers[item.id] ?? ''}
                onChange={(html) => setAnswers((a) => ({ ...a, [item.id]: html }))}
                placeholder="Explain your method, final answer, and any LaTeX working."
              />
              <p className="text-xs text-gray-400 mt-1.5">
                {answers[item.id]?.trim() ? 'Saved locally' : 'Not yet answered'} • Show your working for partial credit.
                {saving && <span className="ml-2 text-gray-400">• Saving…</span>}
                {!saving && lastSavedAt && <span className="ml-2 text-green-500">• Saved to server</span>}
              </p>
            </div>

            {/* Nav buttons */}
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
                disabled={activeIdx === 0}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ArrowLeft className="w-4 h-4" /> Previous
              </button>
              {activeIdx < totalItems - 1 ? (
                <button
                  onClick={() => setActiveIdx((i) => Math.min(totalItems - 1, i + 1))}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-500 rounded-xl shadow hover:shadow-md transition-all"
                >
                  Next <ArrowRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  onClick={() => setConfirmSubmit(true)}
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-green-600 to-emerald-600 rounded-xl shadow-lg hover:shadow-xl transition-all disabled:opacity-60"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  {submitting ? 'Grading…' : 'Submit Exam'}
                </button>
              )}
            </div>

            {confirmSubmit && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/50 backdrop-blur-sm">
                <div className="mx-4 w-full max-w-md rounded-2xl bg-white dark:bg-gray-800 p-6 shadow-2xl">
                  <h3 className="text-lg font-bold text-gray-900 dark:text-white">Submit Exam?</h3>
                  <div className="mt-3 space-y-2 text-sm text-gray-600 dark:text-gray-300">
                    <p>You&apos;ve answered {answeredCount} of {totalItems} questions.</p>
                    {flaggedCount > 0 && (
                      <p className="text-amber-600 dark:text-amber-400 font-medium">
                        {flaggedCount} question{flaggedCount === 1 ? ' is' : 's are'} still flagged for review.
                      </p>
                    )}
                    <p className="font-medium text-gray-800 dark:text-gray-200">
                      Submit for grading now? You cannot change your answers afterwards.
                    </p>
                  </div>
                  <div className="mt-6 flex items-center justify-end gap-3">
                    <button
                      onClick={() => setConfirmSubmit(false)}
                      className="px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-xl transition-colors"
                    >
                      Go back
                    </button>
                    <button
                      onClick={() => { setConfirmSubmit(false); handleSubmit(); }}
                      className="px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-green-600 to-emerald-600 rounded-xl shadow-lg hover:shadow-xl transition-all"
                    >
                      Submit for grading
                    </button>
                  </div>
                </div>
              </div>
            )}

            {submitError && <ErrorBanner message={submitError} />}

            {submitting && (
              <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-2xl p-4 text-sm text-green-800 dark:text-green-300 flex items-center gap-3">
                <Loader2 className="w-5 h-5 animate-spin flex-shrink-0" />
                <span>AI is grading your answers against the markschemes. This can take a minute or two.</span>
              </div>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}
// ===================================================================
// Results review view
// ===================================================================
function ResultsView({ examId, onExit, onRetake }: { examId: string; onExit: () => void; onRetake: () => void }) {
  const [exam, setExam] = useState<ExamDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/mock-exams/${examId}`);
        if (!res.ok) throw new Error('Failed to load results');
        const data = await res.json();
        if (cancelled) return;
        setExam(data.exam);
        if (data.exam?.items?.length) {
          setOpenItems(new Set([data.exam.items[0].id]));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load results');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [examId]);

  const toggleItem = (id: string) =>
    setOpenItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading results…
      </div>
    );
  }
  if (error || !exam) {
    return (
      <div className="h-full p-8">
        <ErrorBanner message={error ?? 'Results not found'} onRetry={onExit} />
      </div>
    );
  }

  const scorePct = exam.totalMarks > 0 && exam.score !== null
    ? Math.round((exam.score / exam.totalMarks) * 100)
    : 0;
  const attempted = exam.items.filter((i) => i.attemptedAt);
  const correctCount = exam.items.filter((i) => i.isCorrect).length;
  const grade = scorePct >= 70 ? 'A' : scorePct >= 60 ? 'B' : scorePct >= 50 ? 'C' : scorePct >= 40 ? 'D' : 'E';
  const gradeColor =
    scorePct >= 70 ? 'text-green-600' : scorePct >= 50 ? 'text-amber-600' : 'text-red-600';

  const sections: Record<string, ExamItem[]> = {};
  for (const item of exam.items) {
    const key = item.sectionTitle || 'Section A';
    if (!sections[key]) sections[key] = [];
    sections[key].push(item);
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Score banner */}
      <div className="bg-gradient-to-br from-green-500 to-emerald-600 text-white">
        <div className="max-w-5xl mx-auto px-6 md:px-8 py-8">
          <div className="flex items-start justify-between gap-4">
            <button
              onClick={onExit}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white/15 hover:bg-white/25 rounded-xl backdrop-blur transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> Back to exams
            </button>
            <button
              onClick={onRetake}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white/15 hover:bg-white/25 rounded-xl backdrop-blur transition-colors"
            >
              <RefreshCw className="w-4 h-4" /> New exam
            </button>
          </div>

          <div className="mt-6 flex flex-col md:flex-row md:items-end md:justify-between gap-6">
            <div>
              <p className="text-green-100 text-sm">Mock Exam Results</p>
              <h1 className="text-3xl font-bold mt-1">{exam.title}</h1>
              <p className="text-green-100 text-sm mt-2">
                {exam.subjectCode ?? 'Exam'} • Submitted {fmtDate(exam.submittedAt)}
              </p>
            </div>
            <div className="flex items-center gap-6">
              <div className="text-center">
                <div className="text-5xl font-bold">{grade}</div>
                <div className="text-xs text-green-100 mt-1 uppercase tracking-wide">Grade</div>
              </div>
              <div className="text-center">
                <div className="text-5xl font-bold">{scorePct}%</div>
                <div className="text-xs text-green-100 mt-1 uppercase tracking-wide">Score</div>
              </div>
              <div className="text-center">
                <div className="text-3xl font-bold">
                  {Math.round(exam.score ?? 0)}
                  <span className="text-lg text-green-200">/{exam.totalMarks}</span>
                </div>
                <div className="text-xs text-green-100 mt-1 uppercase tracking-wide">Marks</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="max-w-5xl mx-auto px-6 md:px-8 py-6 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <SummaryStat icon={<FileText className="w-5 h-5" />} label="Questions" value={`${exam.items.length}`} tint="blue" />
          <SummaryStat icon={<CheckCircle2 className="w-5 h-5" />} label="Attempted" value={`${attempted.length}`} tint="indigo" />
          <SummaryStat icon={<Target className="w-5 h-5" />} label="Fully correct" value={`${correctCount}`} tint="green" />
          <SummaryStat icon={<Award className="w-5 h-5" />} label="Accuracy" value={`${attempted.length ? Math.round((correctCount / attempted.length) * 100) : 0}%`} tint="purple" />
        </div>

        {Object.entries(sections).map(([sectionTitle, items]) => {
          const sectionScore = items.reduce((acc, i) => acc + (i.score ?? 0), 0);
          const sectionMax = items.reduce((acc, i) => acc + i.marks, 0);
          return (
            <div key={sectionTitle} className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">{sectionTitle}</h3>
                <span className={`text-sm font-semibold ${gradeColor}`}>
                  {Math.round(sectionScore)} / {sectionMax} marks
                </span>
              </div>

              {items.map((item) => {
                const isOpen = openItems.has(item.id);
                const full = item.isCorrect === true;
                const partial = item.isCorrect === false && (item.score ?? 0) > 0;
                const wrong = item.isCorrect === false && (item.score ?? 0) === 0;
                const unanswered = item.attemptedAt === null;
                return (
                  <div key={item.id} className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden">
                    <button
                      onClick={() => toggleItem(item.id)}
                      className="w-full flex items-center justify-between gap-4 p-4 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
                          full ? 'bg-green-100 text-green-600'
                            : partial ? 'bg-amber-100 text-amber-600'
                            : wrong ? 'bg-red-100 text-red-600'
                            : 'bg-gray-100 text-gray-500'
                        }`}>
                          {full ? <CheckCircle2 className="w-5 h-5" />
                            : unanswered ? <Clock className="w-5 h-5" />
                            : <XCircle className="w-5 h-5" />}
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                            Q{item.number}{item.part || ''}{item.subPart || ''}{' '}
                            <span className="text-gray-400 font-normal">· {item.marks} marks</span>
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {unanswered ? 'Not attempted' : `Scored ${item.score ?? 0} / ${item.marks}`}
                          </p>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 text-gray-400 flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    </button>

                    {isOpen && (
                      <div className="px-4 pb-4 pt-1 border-t border-gray-100 dark:border-gray-700 space-y-4">
                        <div>
                          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Question</p>
                          <div className="text-sm text-gray-900 dark:text-gray-100">
                            <ExamContent
                              content={item.content}
                              strips={item.strips}
                              alt={`Question ${item.number}`}
                            />
                          </div>
                        </div>

                        <div>
                          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Your answer</p>
                          {item.answer ? (
                            <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl p-3 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap">
                              {item.answer}
                            </div>
                          ) : (
                            <p className="text-sm text-gray-400 italic">No answer submitted.</p>
                          )}
                        </div>

                        {item.modelAnswer && (
                          <FeedbackBlock label="Model answer" icon={<CheckCircle2 className="w-4 h-4" />} tone="green">
                            <FormattedMessage content={item.modelAnswer} />
                          </FeedbackBlock>
                        )}

                        {(item.markschemeContent ||
                          (item.markschemeStrips?.length ?? 0) > 0) && (
                          <FeedbackBlock label="Original mark scheme" icon={<FileText className="w-4 h-4" />} tone="blue">
                            <ExamContent
                              content={item.markschemeContent}
                              strips={item.markschemeStrips}
                              alt={`Mark scheme for question ${item.number}`}
                            />
                          </FeedbackBlock>
                        )}

                        {item.explanation && (
                          <FeedbackBlock label="Examiner feedback" icon={<Lightbulb className="w-4 h-4" />} tone="amber">
                            <FormattedMessage content={item.explanation} />
                          </FeedbackBlock>
                        )}

                        {(item.strengths?.length > 0 || item.weaknesses?.length > 0) && (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            {item.strengths?.length > 0 && (
                              <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-3">
                                <p className="text-xs font-semibold text-green-700 dark:text-green-300 uppercase mb-2">Strengths</p>
                                <ul className="space-y-1">
                                  {item.strengths.map((s, i) => (
                                    <li key={i} className="text-sm text-green-800 dark:text-green-200 flex gap-2">
                                      <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {s}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {item.weaknesses?.length > 0 && (
                              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-3">
                                <p className="text-xs font-semibold text-red-700 dark:text-red-300 uppercase mb-2">To improve</p>
                                <ul className="space-y-1">
                                  {item.weaknesses.map((w, i) => (
                                    <li key={i} className="text-sm text-red-800 dark:text-red-200 flex gap-2">
                                      <XCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {w}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SummaryStat({ icon, label, value, tint }: { icon: React.ReactNode; label: string; value: string; tint: 'blue' | 'green' | 'amber' | 'purple' | 'indigo' }) {
  const tints: Record<string, string> = {
    blue: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300',
    green: 'bg-green-50 dark:bg-green-900/30 text-green-600 dark:text-green-300',
    amber: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-300',
    purple: 'bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-300',
    indigo: 'bg-indigo-50 text-indigo-600',
  };
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm p-4 flex items-center gap-3">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${tints[tint]}`}>
        {icon}
      </div>
      <div>
        <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{value}</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      </div>
    </div>
  );
}

function FeedbackBlock({ label, icon, tone, children }: { label: string; icon: React.ReactNode; tone: 'green' | 'amber' | 'blue'; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    green: 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-200',
    amber: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-200',
    blue: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-800 dark:text-blue-200',
  };
  return (
    <div className={`rounded-xl border p-3 ${tones[tone]}`}>
      <p className="text-xs font-semibold uppercase tracking-wide mb-2 flex items-center gap-1.5 opacity-80">
        {icon} {label}
      </p>
      <div className="text-sm">{children}</div>
    </div>
  );
}
