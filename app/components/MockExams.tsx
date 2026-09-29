'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import NoticeDialog from './NoticeDialog';
import { useConfirm } from './useConfirm';
import PreviewNotice from './PreviewNotice';
import QuestionScratchpadPanel from './QuestionScratchpadPanel';
import { useScreenContext } from './ScreenContext';
import toast from 'react-hot-toast';
import { normalizeOptionLetter } from '@/lib/bank-grading';
import { hasStudentAnswer } from '@/lib/mock-exam-answers';
import { Plus, Clock, Award, Trash2, Play, ArrowRight, ArrowLeft,
  CheckCircle2, XCircle, Sparkles, FileText, ChevronRight, Loader2, AlertCircle, Target, RefreshCw, X, Lightbulb, Flag,
  Image as ImageIcon,
} from 'lucide-react';
import { Badge, Button, Card, CardRow, PageHeader, type BadgeTone } from './ui';

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
            className="block max-w-full paper-ground"
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
  /**
   * The letters this question offers, or null when it is free response.
   * The server sends the option list rather than the key, so the exam can
   * draw the buttons without handing the student the answer.
   */
  options?: string[] | null;
  /** Null until the paper is submitted. */
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
  /**
   * Resolved on the server against real grade thresholds where any are on
   * file. Null until the paper is submitted. `source` says how much to trust
   * it -- an estimate must never be presented as an official grade.
   */
  grade: {
    grade: string;
    source: 'published' | 'school' | 'estimate';
    scale: 'caie' | 'ib';
    isFallback: boolean;
  } | null;
  /**
   * The same paper measured against the target grade set for this subject in
   * /account. Null when no target is set, when the stored target is not on
   * the board's scale, or before submission -- the three cases where there is
   * nothing honest to show.
   */
  targetProgress?: {
    target: { grade: string; requiredPercent: number; source: 'published' | 'school' | 'estimate'; isFallback: boolean };
    requiredMarks: number;
    shortfall: number;
    met: boolean;
  } | null;
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
// Tones rather than five hand-written class strings, so a status badge here
// looks like a status badge everywhere else. Sentence case too: "In Progress"
// was the only Title Case label on the screen.
const STATUS_META: Record<ExamStatus, { label: string; tone: BadgeTone }> = {
  generating: { label: 'Building…', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
  generated: { label: 'Ready', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'warning' },
  completed: { label: 'Completed', tone: 'accent' },
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
export default function MockExams({
  initialSubjectCode = null,
}: {
  /**
   * Open straight onto the generator with this syllabus code chosen, for the
   * course cards on the dashboard. A student who clicked "Mock exam" on their
   * Physics card previously landed on the exam list and had to find the
   * button, open the generator and pick Physics again.
   *
   * Read on mount only, so the caller keys this component on it.
   */
  initialSubjectCode?: string | null;
} = {}) {
  const { confirm, confirmDialog } = useConfirm();
  const [view, setView] = useState<View>(
    initialSubjectCode ? { name: 'configure' } : { name: 'list' },
  );
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
        initialSubjectCode={initialSubjectCode}
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
  // One quiet line instead of a KPI row. The average is stated only once
  // something has been marked -- an average over nothing is not a fact, and
  // rendering it as "—" in a big tile was worse than leaving it out.
  const completed = exams.filter((e) => e.status === 'completed');
  const scored = completed.filter((e) => e.score !== null);
  const average = scored.length === 0 ? null : Math.round(
    scored.reduce((acc, e) => acc + (e.score ?? 0) / (e.totalMarks || 1), 0) / scored.length * 100,
  );
  const summary = exams.length === 0 ? undefined : [
    `${exams.length} ${exams.length === 1 ? 'paper' : 'papers'}`,
    completed.length > 0 ? `${completed.length} completed` : null,
    exams.filter((e) => e.status === 'in_progress').length > 0
      ? `${exams.filter((e) => e.status === 'in_progress').length} in progress` : null,
    average === null ? null : `${average}% average`,
  ].filter(Boolean).join(' · ');

  return (
    <div className="h-full overflow-y-auto p-6 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <PreviewNotice feature="mock-exams" />
        <PageHeader
          title="Mock Exams"
          /*
           * The four stat tiles that were here are one line now.
           *
           * They were the most recognisable generated-dashboard motif on the
           * site: four equal bordered boxes, each with a tinted icon square,
           * for four numbers that mean the same kind of thing. The last of
           * them greeted a student with their average score before they had
           * done anything, which is the worst possible first sentence.
           *
           * The explanatory paragraph went with them. A student who has
           * clicked "Mock Exams" knows what mock exams are; the page does not
           * need to introduce itself.
           */
          description={summary}
          actions={
            <Button variant="primary" onClick={() => setView({ name: 'configure' })} icon={Plus}>
              New Mock Exam
            </Button>
          }
        />

        {/* List */}
        {loadingList && exams.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-muted">
            <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading exams…
          </div>
        ) : listError ? (
          <ErrorBanner message={listError} onRetry={refreshList} />
        ) : exams.length === 0 ? (
          <EmptyState onCreate={() => setView({ name: 'configure' })} />
        ) : (
          /*
           * One surface, not one per paper.
           *
           * Every row used to be its own bordered, rounded, padded card, so a
           * list of nine papers was nine competing boxes and the page had no
           * shape. `CardRow` was written for exactly this and had never been
           * used anywhere.
           */
          <Card padding="none">
            {exams.map((exam) => (
              <ExamCard
                key={exam.id}
                exam={exam}
                onDelete={async () => {
                  const ok = await confirm({
                    title: 'Delete this mock exam?',
                    message: `"${exam.title}" and every answer and mark on it will be removed. This cannot be undone.`,
                    confirmLabel: 'Delete exam',
                  });
                  if (!ok) return;
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
          </Card>
        )}

        <NoticeDialog
          open={notice !== null}
          title={notice?.title ?? ''}
          message={notice?.message ?? ''}
          tone={notice?.tone ?? 'info'}
          onClose={() => setNotice(null)}
        />
        {confirmDialog}
      </div>
    </div>
  );
}

// --------------------------- Subcomponents: list ---------------------------
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="bg-surface rounded-lg border border-dashed border-strong p-12 text-center">
      <div className="w-16 h-16 mx-auto rounded-lg bg-accent flex items-center justify-center mb-4">
        <Sparkles className="w-8 h-8 text-white" />
      </div>
      <h3 className="text-lg font-bold text-primary">No mock exams yet</h3>
      <p className="text-sm text-muted mt-1 max-w-md mx-auto">
        Create your first mock exam. Pick a subject and a mark total —
        we&apos;ll assemble a paper from real past-paper questions.
      </p>
      <button
        onClick={onCreate}
        className="mt-5 inline-flex items-center gap-2 px-4 py-2.5 bg-accent text-white rounded-lg font-semibold transition-all"
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

  /*
   * The five icon chips are one line of text.
   *
   * They read `0625 · 9 questions · 75 min · 80 marks · Created Sep 27` --
   * five items of equal weight, each with its own small icon, directly above a
   * description that said the same thing again in prose. Metadata about a
   * database row, presented as if it were the content.
   *
   * What a student actually needs to recognise a paper is which paper it is,
   * and what it is worth. The rest is available when they open it.
   */
  const detail = [
    exam.subjectCode,
    `${exam.questionCount} questions`,
    `${exam.totalMarks} marks`,
    `${exam.durationMinutes} min`,
  ].filter(Boolean).join(' · ');

  return (
    <CardRow className="items-start gap-4 px-5 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="text-lg font-semibold tracking-tight text-primary truncate">
            {exam.title}
          </h3>
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </div>
        <p className="mt-1 text-sm text-secondary">{detail}</p>
        <p className="mt-0.5 text-xs text-muted">
          Created {fmtDate(exam.createdAt)}
          {pct !== null && ` · scored ${Math.round(exam.score ?? 0)} of ${exam.totalMarks}`}
        </p>
      </div>

      {/*
        * Score and action in one column, instead of a bordered footer strip.
        *
        * The topic chips that shared that strip are gone: three of a paper's
        * topics, truncated with "+2", told a student nothing they could act on
        * and added a third row of grey pills to every item in the list.
        */}
      <div className="flex items-center gap-3 shrink-0">
        {pct !== null && (
          /*
           * Quiet, and one colour rather than three.
           *
           * At 28px in red this was the loudest thing on the screen, and what
           * it was shouting was a student's worst result -- "0%" in danger red,
           * twice, above a list of papers they had not sat yet. The three-way
           * green/amber/red also turned every row back into a traffic light,
           * which is the same decoration the stat tiles were removed for.
           *
           * The exact figure is already on the line below ("scored 0 of 20"),
           * so this only has to be scannable. Following StatTile's rule: only
           * a fall is coloured.
           */
          <div className={`text-base font-semibold tabular-nums ${pct < 40 ? 'text-danger' : 'text-secondary'}`}>
            {pct}%
          </div>
        )}
        {exam.status === 'failed' ? (
          <span className="text-xs text-danger max-w-[16rem] text-right">
            {exam.generationError ?? 'This paper could not be generated.'}
          </span>
        ) : exam.status === 'generating' ? (
          <span className="text-xs text-muted">Still building…</span>
        ) : exam.status === 'completed' ? (
          <Button variant="secondary" size="sm" onClick={onViewResults}>View results</Button>
        ) : (
          <Button variant="primary" size="sm" onClick={onOpen} icon={Play}>
            {exam.status === 'in_progress' ? 'Resume' : 'Start'}
          </Button>
        )}
        <button
          onClick={onDelete}
          className="p-2 text-muted hover:text-danger hover:bg-danger-subtle rounded-md transition-colors"
          title="Delete" aria-label={`Delete ${exam.title}`}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </CardRow>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="bg-danger-subtle border border-danger-border rounded-lg p-5 flex items-start gap-3">
      <AlertCircle className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" />
      <div className="flex-1">
        <p className="text-sm font-semibold text-danger">{message}</p>
        {onRetry && (
          <button onClick={onRetry} className="mt-2 text-sm text-danger underline">
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
/**
 * One real paper shape from `/api/mock-exams/formats`.
 *
 * Two sources in one object, and the distinction is the point. `questionCount`
 * is measured from the papers we hold, because no board publishes how its
 * marks are spread across questions. `name`, `minutes` and `totalMarks` are
 * the board's own, because our extraction is lossy and got them badly wrong --
 * IGCSE History Paper 4 measured 520 marks against an official 40.
 */
type PaperFormat = {
  paperNumber: number;
  level: string;
  questionCount: number;
  totalMarks: number;
  style: 'mcq' | 'structured';
  papersObserved: number;
  recommended: boolean;
  /** The board's name for the paper: "Theory (Extended)". Null for IB papers, which are only numbered. */
  name: string | null;
  /** Null where the board prints none -- coursework, and every IB Language A paper. */
  minutes: number | null;
  marksAreOfficial: boolean;
  officialSource: 'cambridge-syllabus' | 'ib-paper-cover' | null;
};

/** "1 hour 15 minutes" reads better on a card as "1h 15m". */
function shortDuration(minutes: number | null): string | null {
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function ConfigureView({
  initialSubjectCode = null,
  onCancel,
  onGenerated,
}: {
  initialSubjectCode?: string | null;
  onCancel: () => void;
  onGenerated: (id: string) => void;
}) {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loadingFilters, setLoadingFilters] = useState(true);

  const [mode, setMode] = useState<'mock' | 'predicted'>('mock');
  const [subjectCode, setSubjectCode] = useState('');
  const [difficulty, setDifficulty] = useState<string>('mixed');
  const [totalMarks, setTotalMarks] = useState(50);
  /**
   * The paper shapes this subject is actually sat in, measured from the real
   * papers in the corpus by `/api/mock-exams/formats`.
   *
   * A mark total is the wrong question to ask a student: "80 marks of
   * Physics" describes no paper anyone sits. "Paper 4 - 9 questions, 70
   * marks" describes one they have seen. `null` means the format is a custom
   * mark total, which is what every generated paper used to be.
   */
  const [formats, setFormats] = useState<PaperFormat[]>([]);
  const [paperNumber, setPaperNumber] = useState<number | null>(null);
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
          /*
           * A requested code wins over the first in the list, but only if
           * generation can actually serve it -- this list is already narrowed
           * to the subjects that have a usable paper, and preselecting one
           * outside it is how 0606 got offered and then refused. A course in a
           * subject with no paper falls back to the default, which is honest:
           * the generator opens, just not on that subject.
           */
          const requested = initialSubjectCode
            ? data.subjects.find(
                (option: Subject) =>
                  option.code.toLowerCase() === initialSubjectCode.toLowerCase(),
              )
            : undefined;
          setSubjectCode(requested?.code ?? data.subjects[0].code);
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

  // Reloaded per subject, because the shapes are per syllabus: Physics has
  // six papers, Economics four, and offering one subject's list against
  // another's would promise a paper that cannot be generated.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Inside the async body rather than as an early return: a synchronous
      // setState in an effect triggers a cascading render, which ESLint
      // rejects and React charges for.
      if (!subjectCode) {
        if (!cancelled) { setFormats([]); setPaperNumber(null); }
        return;
      }
      try {
        const res = await fetch(`/api/mock-exams/formats?subjectCode=${encodeURIComponent(subjectCode)}`);
        const data = await res.json();
        if (cancelled) return;
        const next: PaperFormat[] = Array.isArray(data.formats) ? data.formats : [];
        setFormats(next);
        // Default to a real paper rather than a mark total: the recommended
        // one is the heaviest, which is what "a mock exam" usually means.
        setPaperNumber(next.find((f) => f.recommended)?.paperNumber ?? next[0]?.paperNumber ?? null);
      } catch {
        // A format list we cannot load is not a reason to block generation --
        // the mark-total path still works and is what the form did before.
        if (!cancelled) { setFormats([]); setPaperNumber(null); }
      }
    })();
    return () => { cancelled = true; };
  }, [subjectCode]);

  const selectedFormat = formats.find((f) => f.paperNumber === paperNumber) ?? null;
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
          /*
           * The chosen paper's own figures, falling back to the sliders.
           *
           * Read off `selectedFormat` rather than mirrored into `totalMarks`
           * and `durationMinutes` when a card is clicked, because those two
           * are the *custom* controls -- they are only rendered when
           * `paperNumber === null`, and an effect further up re-picks a
           * recommended format whenever the subject changes, which would race
           * any mirroring. Deriving here cannot drift from what the cards say.
           *
           * Sending the untouched defaults was harmless for a plain mock,
           * which the server re-derives from `paperNumber`, and wrong for a
           * predicted paper, which took them at face value: choosing Physics
           * Paper 3 -- 80 marks, 1h15m, under a line promising the syllabus
           * figures -- produced a 50-mark paper on a 90-minute clock.
           */
          totalMarks: selectedFormat?.totalMarks ?? totalMarks,
          durationMinutes: selectedFormat?.minutes ?? durationMinutes,
          difficulty,
          title: title.trim() || undefined,
          mode,
          // Omitted for a custom mark total, which is what the server treats
          // as "pack to the total" rather than "shape it like a real paper".
          ...(paperNumber === null ? {} : { paperNumber }),
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
            className="p-2 text-muted hover:text-secondary hover:bg-surface-hover rounded-md transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="text-2xl font-bold text-primary">Generate a Mock Exam</h2>
            <p className="text-sm text-muted">
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
          <div className="flex-1 h-px bg-surface-active" />
          <StepDot n={2} label="Generate" />
          <div className="flex-1 h-px bg-surface-active" />
          <StepDot n={3} label="Take Exam" />
        </div>

        {/* Form card */}
        <div className="bg-surface rounded-lg border border-line p-6 space-y-5">
          {loadingFilters ? (
            <div className="flex items-center justify-center py-10 text-muted">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading subjects…
            </div>
          ) : (
            <>
              <Field label="Paper type">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setMode('mock')}
                    className={`px-3 py-2 text-sm font-medium rounded-lg border transition-all ${
                      mode === 'mock'
                        ? 'bg-accent text-white border-transparent shadow'
                        : 'bg-surface text-secondary border-strong hover:border-accent'
                    }`}
                  >
                    Mock exam
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('predicted')}
                    className={`px-3 py-2 text-sm font-medium rounded-lg border transition-all ${
                      mode === 'predicted'
                        ? 'bg-accent text-white border-transparent shadow'
                        : 'bg-surface text-secondary border-strong hover:border-strong'
                    }`}
                  >
                    Predicted paper
                  </button>
                </div>
                <p className="text-xs text-muted mt-1">
                  Predicted papers use the question bank plus observed paper structure and mark schemes.
                </p>
              </Field>

              <Field label="Exam title (optional)">
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Paper 2 mechanics refresher"
                  className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm text-primary focus:ring-2 focus:ring-ring/25 focus:border-transparent outline-none"
                />
              </Field>

              <Field label="Subject" required>
                {subjects.length === 0 ? (
                  // Rather than an empty dropdown above a dead button. This is
                  // reachable: a student may be enrolled only in subjects whose
                  // mark schemes have not been linked yet.
                  <p className="text-sm text-muted">
                    None of your subjects have marked questions in the bank yet, so a
                    paper cannot be assembled. Browse the question bank in Practice
                    in the meantime.
                  </p>
                ) : (
                  <select
                    value={subjectCode}
                    onChange={(e) => setSubjectCode(e.target.value)}
                    className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm text-primary focus:ring-2 focus:ring-ring/25 focus:border-transparent outline-none"
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
                      className={`px-3 py-2 text-sm font-medium rounded-lg border transition-all capitalize ${
                        difficulty === d
                          ? 'bg-accent text-white border-transparent shadow'
                          : 'bg-surface text-secondary border-strong hover:border-accent'
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </Field>
              )}

              {formats.length > 0 && (
                <Field label="Paper">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {formats.map((format) => (
                      <button
                        key={`${format.level}-${format.paperNumber}`}
                        type="button"
                        onClick={() => setPaperNumber(format.paperNumber)}
                        className={`rounded-lg border px-3 py-2 text-left transition-all ${
                          paperNumber === format.paperNumber
                            ? 'bg-accent text-white border-transparent shadow'
                            : 'bg-surface text-secondary border-strong hover:border-accent'
                        }`}
                      >
                        <span className="block text-sm font-semibold">Paper {format.paperNumber}</span>
                        {/* The board's name where there is one. It is what the
                            student sees on the real cover, and it tells Core
                            from Extended -- which the number alone does not. */}
                        {format.name && (
                          <span className={`block truncate text-xs font-medium ${paperNumber === format.paperNumber ? 'text-white/90' : 'text-secondary'}`}>
                            {format.name}
                          </span>
                        )}
                        <span className={`block text-xs ${paperNumber === format.paperNumber ? 'text-white/80' : 'text-muted'}`}>
                          {format.totalMarks} marks
                          {shortDuration(format.minutes) ? ` · ${shortDuration(format.minutes)}` : ''}
                        </span>
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setPaperNumber(null)}
                      className={`rounded-lg border px-3 py-2 text-left transition-all ${
                        paperNumber === null
                          ? 'bg-accent text-white border-transparent shadow'
                          : 'bg-surface text-secondary border-strong hover:border-accent'
                      }`}
                    >
                      <span className="block text-sm font-semibold">Custom</span>
                      <span className={`block text-xs ${paperNumber === null ? 'text-white/80' : 'text-muted'}`}>
                        Choose your own mark total
                      </span>
                    </button>
                  </div>
                  {selectedFormat && (
                    <p className="mt-2 text-xs text-muted">
                      {selectedFormat.questionCount} {selectedFormat.style === 'mcq' ? 'multiple-choice questions' : 'questions'}
                      {' '}worth {selectedFormat.totalMarks} marks
                      {selectedFormat.minutes ? ` in ${shortDuration(selectedFormat.minutes)}` : ''}, drawn from
                      different past papers and laid out like the
                      {' '}{selectedFormat.papersObserved} real sittings this shape was measured from.
                      {/* Saying where the total comes from matters: it is the
                          board's figure, so it matches the real cover, while
                          the question count is ours. */}
                      {selectedFormat.marksAreOfficial && (
                        <>
                          {' '}The mark total and timing are
                          {selectedFormat.officialSource === 'ib-paper-cover'
                            ? ' the ones printed on the real IB paper.'
                            : ' the ones in the Cambridge syllabus.'}
                        </>
                      )}
                    </p>
                  )}
                </Field>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {/* The mark total only means anything when no paper shape is
                    chosen -- a Paper 4 is 70 marks because that is what a
                    Paper 4 is, and a slider beside it would imply otherwise. */}
                {paperNumber === null && (
                <Field label={`Total marks: ${totalMarks}`}>
                  <input
                    type="range"
                    min={20}
                    max={120}
                    step={10}
                    value={totalMarks}
                    onChange={(e) => setTotalMarks(Number(e.target.value))}
                    className="w-full accent-[var(--accent)]"
                  />
                  <div className="flex justify-between text-xs text-muted mt-1">
                    <span>20</span><span>120</span>
                  </div>
                </Field>
                )}

                {/* The clock is the board's whenever it publishes one, and the
                    server uses that regardless of what is sent -- so offering a
                    slider beside it would be a control that does nothing. Same
                    rule as the mark total above: a Paper 1 is sat in 45 minutes
                    because that is what a Paper 1 is. */}
                {selectedFormat?.minutes ? (
                  <Field label="Duration">
                    <p className="text-sm text-secondary">
                      {shortDuration(selectedFormat.minutes)}, as the real paper is timed.
                    </p>
                  </Field>
                ) : (
                  <Field label={`Duration: ${durationMinutes} min`}>
                    <input
                      type="range"
                      min={30}
                      max={180}
                      step={15}
                      value={durationMinutes}
                      onChange={(e) => setDurationMinutes(Number(e.target.value))}
                      className="w-full accent-[var(--accent)]"
                    />
                    <div className="flex justify-between text-xs text-muted mt-1">
                      <span>30m</span><span>3h</span>
                    </div>
                  </Field>
                )}
              </div>

              {showPredictionSteering && (
                <Field label="Topics (comma-separated, optional)">
                  <input
                    type="text"
                    value={topicsRaw}
                    onChange={(e) => setTopicsRaw(e.target.value)}
                    placeholder="e.g. kinematics, forces, momentum"
                    className="w-full px-3 py-2.5 bg-surface border border-strong rounded-lg text-sm text-primary focus:ring-2 focus:ring-ring/25 focus:border-transparent outline-none"
                  />
                  <p className="text-xs text-muted mt-1">
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
            className="px-4 py-2.5 text-sm font-medium text-secondary bg-surface-raised hover:bg-surface-active rounded-lg transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg transition-all disabled:opacity-60 disabled:cursor-not-allowed"
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
          <div className="bg-accent-subtle border border-accent-border rounded-lg p-4 text-sm text-accent-text flex items-center gap-3">
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
      <span className="block text-sm font-medium text-secondary mb-1.5">
        {label} {required && <span className="text-danger">*</span>}
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
          ? 'bg-accent text-white'
          : active
            ? 'bg-accent text-white shadow'
            : 'bg-surface-active text-muted'
      }`}>
        {done ? <CheckCircle2 className="w-4 h-4" /> : n}
      </div>
      <span className={`text-xs font-medium ${active ? 'text-primary' : 'text-muted'}`}>
        {label}
      </span>
    </div>
  );
}
// ===================================================================
// Take Exam view (timer + per-question answer inputs)
// ===================================================================
function TakeExamView({ examId, onExit, onSubmitted }: { examId: string; onExit: () => void; onSubmitted: (id: string) => void }) {
  const { confirm, confirmDialog } = useConfirm();
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
  /** Last payload the server acknowledged, so autosave can skip no-ops. */
  const lastSavedPayload = useRef<string | null>(null);
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
    const payload = JSON.stringify({ answers: latestAnswers.current });

    // Writing an identical answer sheet again protects nothing, and the 60s
    // timer below runs for as long as the exam is open -- so a student who
    // opens a paper and steps away used to write to the database once a
    // minute, indefinitely. That is enough to stop a serverless Postgres ever
    // reaching its idle timeout; it is how production lost its compute
    // allowance on 19 Sep 2026. Skipping the no-op write costs no safety:
    // a failed save leaves the marker unset, so the next tick retries it.
    if (payload === lastSavedPayload.current) return;

    try {
      setSaving(true);
      const res = await fetch(`/api/mock-exams/${examId}/progress`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal,
      });
      if (res.ok) {
        lastSavedPayload.current = payload;
        setLastSavedAt(Date.now());
      }
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
      // The paper is saved either way. When AI marking is off, multiple choice
      // is still marked from its key and everything else comes back unmarked
      // with the mark scheme attached -- say so, or a half-marked paper reads
      // as a broken feature rather than a setting the student can change.
      if (data.aiDisabled) {
        // JSX rather than a string so the account page is one tap away. A
        // message that names the setting in prose and gives no way to reach it
        // asks the student to go hunting right after they lost their marking.
        toast(
          (
            <span>
              {data.aiNotice ??
                'Your paper was saved. AI marking is off for your account, so written answers are unmarked — compare them against the mark scheme.'}{' '}
              <Link href="/account" className="font-semibold underline underline-offset-2">
                Add an API key
              </Link>
            </span>
          ),
          { duration: 12000, icon: '📝' },
        );
      }
      onSubmitted(examId);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Failed to submit exam');
      setSubmitting(false);
      submittedRef.current = false;
    }
  }

  // Tell the AI tutor which exam question is in front of the student.
  //
  // Above the early returns because a hook cannot sit after one, hence the
  // optional chaining rather than the `item` binding defined further down.
  //
  // `content` is sent and `markschemeContent` is not. The item carries both,
  // and putting the mark scheme into a prompt during a live paper would hand
  // over the answer through the tutor -- the exact thing the server already
  // refuses to do by sending option letters without the key.
  const { updateData } = useScreenContext();
  const liveItem = exam?.items[activeIdx];
  useEffect(() => {
    if (!exam) return;
    updateData({
      examTitle: exam.title,
      examItemPosition: liveItem
        ? `question ${activeIdx + 1} of ${exam.items.length}`
          + (liveItem.part ? ` (part ${liveItem.part})` : '')
        : undefined,
      examItemMarks: liveItem?.marks ?? null,
      examSubmitted: Boolean(exam.submittedAt),
      subjectCode: exam.subjectCode ?? undefined,
      questionText: liveItem?.content ? liveItem.content.slice(0, 500) : undefined,
    });
  }, [exam, liveItem, activeIdx, updateData]);

  useEffect(() => () => {
    // Leaving the paper must clear it, or the tutor keeps telling a student on
    // the dashboard that they are mid-exam and refusing to answer.
    updateData({
      examTitle: undefined, examItemPosition: undefined, examItemMarks: undefined,
      examSubmitted: undefined, questionText: undefined,
    });
  }, [updateData]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted">
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
        <Loader2 className="w-7 h-7 animate-spin text-accent-text" />
        <p className="text-lg font-semibold text-primary">Building your paper…</p>
        <p className="max-w-sm text-sm text-secondary">
          Choosing questions from the bank. This usually takes under a minute, and
          the timer does not start until the paper is ready.
        </p>
        <button
          onClick={onExit}
          className="mt-2 rounded-lg border border-strong px-4 py-2 text-sm font-medium text-secondary transition-colors hover:bg-surface-hover"
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
      {confirmDialog}
      {/* Exam top bar: title, timer, progress */}
      <div className="px-6 py-3 bg-surface border-b border-line flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={async () => {
              // This is the one that most needed replacing: a native confirm
              // blocks the event loop, so firing one here froze the timer, the
              // autosave and the SSE connection until the student noticed the
              // OS dialog and dismissed it -- mid-exam.
              const ok = await confirm({
                title: 'Leave the exam?',
                message:
                  'Your answers are saved and you can resume later, but the timer keeps running while you are away.',
                confirmLabel: 'Save and leave',
                destructive: false,
              });
              if (!ok) return;
              await saveProgress();
              onExit();
            }}
            className="p-2 text-muted hover:text-secondary hover:bg-surface-hover rounded-md transition-colors"
            title="Save & exit exam" aria-label="Save & exit exam"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-primary truncate">{exam.title}</h2>
            <p className="text-xs text-muted">
              {exam.subjectCode ?? 'Exam'} • {totalItems} questions • {exam.totalMarks} marks
            </p>
            {exam.description && (
              <p className="text-[11px] text-muted mt-1 line-clamp-2">{exam.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* `motion-safe:` so the pulse is dropped for anyone who has asked
              for reduced motion -- an unavoidable, indefinitely repeating
              animation in their field of view for the length of an exam is
              exactly what that setting exists to prevent. The colour change
              carries the same warning without moving.

              No `aria-live` here, deliberately: this updates once a second, so
              a live region would read the clock aloud every second for the
              length of the paper. `role="timer"` defaults to off for exactly
              that reason. The label still names the element, so a student who
              navigates to it hears the time on demand. */}
          <div
            role="timer"
            aria-label={timeLow ? 'Time remaining, running low' : 'Time remaining'}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg font-mono text-sm font-semibold tabular-nums ${
              timeLow
                ? 'bg-danger-subtle text-danger border border-danger-border motion-safe:animate-pulse'
                : 'bg-surface-raised text-secondary'
            }`}
          >
            <Clock className="w-4 h-4" aria-hidden="true" />
            {secondsLeft !== null ? fmtTime(secondsLeft) : '—'}
          </div>
          <span className="text-xs text-muted hidden md:inline">
            {answeredCount}/{totalItems} answered
            {flaggedCount > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 text-warning">
                <Flag className="w-3 h-3" /> {flaggedCount} flagged
              </span>
            )}
          </span>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Question navigator sidebar */}
        <aside className="w-14 md:w-48 bg-surface-raised border-r border-line overflow-y-auto p-2 flex-shrink-0">
          <p className="hidden md:block text-xs font-semibold text-muted uppercase px-2 py-2">Questions</p>
          <div className="grid grid-cols-1 gap-1">
            {exam.items.map((it, idx) => {
              const answered = !!(answers[it.id] ?? '').trim();
              const isFlagged = !!flagged[it.id];
              return (
                <button
                  key={it.id}
                  onClick={() => setActiveIdx(idx)}
                  className={`flex items-center gap-2 px-2 py-2 rounded-md text-sm transition-colors ${
                    idx === activeIdx
                      ? 'bg-accent text-white font-semibold'
                      : answered
                        ? 'bg-accent-subtle text-accent-text'
                        : 'text-secondary hover:bg-surface-active'
                  }`}
                  title={`Q${it.number}${it.part || ''}${it.subPart || ''}${isFlagged ? ' (flagged for review)' : ''}`} aria-label={`Q${it.number}${it.part || ''}${it.subPart || ''}${isFlagged ? ' (flagged for review)' : ''}`}
                >
                  <span className="w-6 text-center font-mono text-xs flex-shrink-0">
                    {idx + 1}
                  </span>
                  {answered && idx !== activeIdx && <CheckCircle2 className="w-3 h-3 hidden md:block" />}
                  {isFlagged && (
                    <Flag className={`w-3 h-3 flex-shrink-0 ${idx === activeIdx ? 'text-white' : 'text-warning'}`} fill="currentColor" />
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
                <span className="text-xs font-semibold px-2 py-1 bg-surface-raised text-secondary rounded-md">
                  {item.sectionTitle}
                </span>
                <span className="text-sm font-bold text-primary">
                  Question {activeIdx + 1} of {totalItems}
                </span>
                <span className="text-xs text-muted">
                  Q{item.number}{item.part || ''}{item.subPart || ''}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold px-2 py-1 bg-warning-subtle text-warning border border-warning-border rounded-md">
                  [{item.marks} marks]
                </span>
                <button
                  type="button"
                  onClick={() => setFlagged((f) => ({ ...f, [item.id]: !f[item.id] }))}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-md border transition-colors ${
                    flagged[item.id]
                      ? 'bg-warning text-white border-warning hover:bg-warning'
                      : 'bg-surface text-warning border-warning-border hover:bg-warning-subtle'
                  }`}
                  title={flagged[item.id] ? 'Remove review flag' : 'Mark for review'} aria-label={flagged[item.id] ? 'Remove review flag' : 'Mark for review'}
                >
                  <Flag className="w-3.5 h-3.5" fill={flagged[item.id] ? 'currentColor' : 'none'} />
                  {flagged[item.id] ? 'Flagged' : 'Mark for review'}
                </button>
              </div>
            </div>

            {/* Question content */}
            <div className="bg-surface border border-line rounded-lg p-5">
              <div className="prose prose-sm max-w-none text-primary">
                <ExamContent
                  content={item.content}
                  strips={item.strips}
                  alt={`Question ${item.number}`}
                />
              </div>
            </div>

            {/* Answer area */}
            {/*
              * A question with an answer key gets its options as buttons, the
              * same as practice and the daily challenge. It used to get the
              * rich-text editor like everything else, so picking B stored
              * "<p>B</p>" and the marker -- which reads a leading option
              * letter -- saw "<" and marked a right answer wrong. The grader
              * now flattens markup, but asking for a letter in a WYSIWYG box
              * invites the same class of answer ("B is correct", "the second
              * one") and there is nothing to write out for four fixed options.
              */}
            {item.options?.length ? (
              <div>
                <label className="block text-sm font-medium text-secondary mb-2">
                  Your answer
                </label>
                <div className="flex flex-wrap gap-2">
                  {item.options.map((letter) => {
                    // Read through the same parser the marker uses, so an
                    // answer saved before this existed still shows as picked.
                    const selected = normalizeOptionLetter(answers[item.id] ?? '') === letter;
                    return (
                      <button
                        key={letter}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => setAnswers((a) => ({ ...a, [item.id]: letter }))}
                        className={`h-12 w-12 rounded-lg border text-base font-semibold transition-all ${
                          selected
                            ? 'border-accent bg-accent text-white shadow'
                            : 'border-strong text-secondary hover:border-accent hover:bg-accent-subtle'
                        }`}
                      >
                        {letter}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted mt-2">
                  {answers[item.id]?.trim() ? 'Answer saved' : 'Not yet answered'} • You can change your answer until you submit.
                  {saving && <span className="ml-2 text-muted">• Saving…</span>}
                  {!saving && lastSavedAt && <span className="ml-2 text-accent-text">• Saved to server</span>}
                </p>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-secondary">
                    Your answer
                  </label>
                  <div className="flex items-center gap-2">
                    {images[item.id] && (
                      <button
                        onClick={() => transcribeAnswer(item.id)}
                        disabled={ocrLoading === item.id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-warning text-white hover:bg-warning disabled:opacity-60 transition-all"
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
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-surface-raised text-secondary hover:bg-surface-hover transition-all"
                    >
                      <ImageIcon className="w-3.5 h-3.5" /> Upload photo
                    </button>
                  </div>
                </div>
                {images[item.id] && (
                  <div className="mb-2 flex items-center gap-2 p-2 rounded-md border border-line bg-surface-raised">
                    <img src={images[item.id]} alt="Uploaded answer" className="w-12 h-12 object-cover rounded-sm border border-line" />
                    <span className="text-xs text-muted flex-1">Photo attached — transcribe or submit as-is.</span>
                    <button onClick={() => setImages((prev) => { const next = { ...prev }; delete next[item.id]; return next; })} className="text-xs font-medium text-danger hover:text-danger">Remove</button>
                  </div>
                )}
                <RichTextEditor
                  content={answers[item.id] ?? ''}
                  onChange={(html) => setAnswers((a) => ({ ...a, [item.id]: html }))}
                  placeholder="Explain your method, final answer, and any LaTeX working."
                />
                <p className="text-xs text-muted mt-1.5">
                  {answers[item.id]?.trim() ? 'Saved locally' : 'Not yet answered'} • Show your working for partial credit.
                  {saving && <span className="ml-2 text-muted">• Saving…</span>}
                  {!saving && lastSavedAt && <span className="ml-2 text-accent-text">• Saved to server</span>}
                </p>
                <QuestionScratchpadPanel questionRef={{ mockExamItemId: item.id }} className="mt-2" />
              </div>
            )}

            {/* Nav buttons */}
            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => setActiveIdx((i) => Math.max(0, i - 1))}
                disabled={activeIdx === 0}
                className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-secondary bg-surface-raised hover:bg-surface-active rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ArrowLeft className="w-4 h-4" /> Previous
              </button>
              {activeIdx < totalItems - 1 ? (
                <button
                  onClick={() => setActiveIdx((i) => Math.min(totalItems - 1, i + 1))}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all"
                >
                  Next <ArrowRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  onClick={() => setConfirmSubmit(true)}
                  disabled={submitting}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg transition-all disabled:opacity-60"
                >
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                  {submitting ? 'Grading…' : 'Submit Exam'}
                </button>
              )}
            </div>

            {confirmSubmit && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface/50 backdrop-blur-sm">
                <div className="mx-4 w-full max-w-md rounded-lg bg-surface p-6 shadow-overlay">
                  <h3 className="text-lg font-bold text-primary">Submit Exam?</h3>
                  <div className="mt-3 space-y-2 text-sm text-secondary">
                    <p>You&apos;ve answered {answeredCount} of {totalItems} questions.</p>
                    {flaggedCount > 0 && (
                      <p className="text-warning font-medium">
                        {flaggedCount} question{flaggedCount === 1 ? ' is' : 's are'} still flagged for review.
                      </p>
                    )}
                    <p className="font-medium text-primary">
                      Submit for grading now? You cannot change your answers afterwards.
                    </p>
                  </div>
                  <div className="mt-6 flex items-center justify-end gap-3">
                    <button
                      onClick={() => setConfirmSubmit(false)}
                      className="px-4 py-2.5 text-sm font-medium text-secondary bg-surface-raised hover:bg-surface-active rounded-lg transition-colors"
                    >
                      Go back
                    </button>
                    <button
                      onClick={() => { setConfirmSubmit(false); handleSubmit(); }}
                      className="px-5 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg transition-all"
                    >
                      Submit for grading
                    </button>
                  </div>
                </div>
              </div>
            )}

            {submitError && <ErrorBanner message={submitError} />}

            {submitting && (
              <div className="bg-accent-subtle border border-accent-border rounded-lg p-4 text-sm text-accent-text flex items-center gap-3">
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
      <div className="h-full flex items-center justify-center text-muted">
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
  /*
   * Answered, marked, and the gap between them.
   *
   * `hasStudentAnswer` carries the reasoning about which field means what.
   *
   * `score === null` is the reliable marker for "not marked": every grading
   * path that succeeds writes a number, and all three ungraded branches write
   * null. That covers AI being off, a question with no transcript, and an
   * upstream failure.
   */
  const answered = exam.items.filter(hasStudentAnswer);
  /*
   * Marking is judged over the answers the student *gave*, not over every item.
   *
   * An unanswered question is scored 0 by the official path, not left null --
   * a blank earns no marks and that is a real, correct mark. So counting
   * `score !== null` across all items said "9 of 10 were marked" for a paper
   * where the student wrote one answer and that one answer could not be
   * marked. The grade was then computed almost entirely from blanks and
   * displayed as though it measured them.
   */
  const markedAnswers = answered.filter((i) => i.score !== null);
  const unmarkedAnswers = answered.length - markedAnswers.length;
  const attempted = answered;
  const correctCount = exam.items.filter((i) => i.isCorrect).length;
  // The grade comes from the server, which reads real thresholds for the
  // subject. This used to be a fixed percentage ladder applied to every board:
  // it ignored the published thresholds, which move each session and mostly sit
  // well below 70%, and it handed IB students a letter for a qualification
  // graded 1-7.
  const grade = exam.grade?.grade ?? '--';
  const gradeNote = !exam.grade
    ? null
    : exam.grade.source === 'published'
      ? 'Official grade thresholds'
      : exam.grade.source === 'school'
        ? 'School grade boundaries'
        : exam.grade.isFallback
          ? 'Estimated — no grade boundaries on file'
          : 'Estimated grade boundaries';
  const gradeColor =
    scorePct >= 70 ? 'text-accent-text' : scorePct >= 50 ? 'text-warning' : 'text-danger';

  const sections: Record<string, ExamItem[]> = {};
  for (const item of exam.items) {
    const key = item.sectionTitle || 'Section A';
    if (!sections[key]) sections[key] = [];
    sections[key].push(item);
  }

  return (
    <div className="h-full overflow-y-auto">
      {/* Score banner */}
      <div className="bg-accent text-white">
        <div className="max-w-5xl mx-auto px-6 md:px-8 py-8">
          <div className="flex items-start justify-between gap-4">
            <button
              onClick={onExit}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white/15 hover:bg-white/25 rounded-lg backdrop-blur transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> Back to exams
            </button>
            <button
              onClick={onRetake}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-white/15 hover:bg-white/25 rounded-lg backdrop-blur transition-colors"
            >
              <RefreshCw className="w-4 h-4" /> New exam
            </button>
          </div>

          <div className="mt-6 flex flex-col md:flex-row md:items-end md:justify-between gap-6">
            <div>
              <p className="text-accent-text text-sm">Mock Exam Results</p>
              <h2 className="text-3xl font-bold mt-1">{exam.title}</h2>
              <p className="text-accent-text text-sm mt-2">
                {exam.subjectCode ?? 'Exam'} • Submitted {fmtDate(exam.submittedAt)}
              </p>
              {/* The score is out of the whole paper, so an unmarked question
                  silently costs marks the student may well have earned. */}
              {markedAnswers.length > 0 && unmarkedAnswers > 0 && (
                <p className="text-accent-text text-sm mt-2 max-w-md leading-relaxed">
                  {unmarkedAnswers} of your {answered.length} answers could not be marked
                  automatically and count as zero here. Mark those yourself below.
                </p>
              )}
            </div>
            {/*
              A paper nothing could be marked on has no score, and must not be
              given one.

              It used to render the full trio regardless: a student who sat
              seventy-five minutes while the AI provider was down was shown
              "E", "0%" and "0/80" in large type. Every per-question note said
              marking was unavailable, but nobody reads ten notes before
              reading the grade. The honest reading of an unmarked paper is
              that it is unmarked.
            */}
            {answered.length > 0 && markedAnswers.length === 0 ? (
              <div className="max-w-sm md:text-right">
                <div className="text-3xl font-bold">Not marked</div>
                <p className="text-accent-text text-sm mt-2 leading-relaxed">
                  None of your answers could be marked automatically, so this
                  paper has no score. They are saved below — award yourself the
                  marks against each mark scheme.
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-6">
                <div className="text-center">
                  <div className="text-5xl font-bold">{grade}</div>
                  <div className="text-xs text-accent-text mt-1 uppercase tracking-wide">
                    {exam.grade?.scale === 'ib' ? 'IB Grade' : 'Grade'}
                  </div>
                  {gradeNote && (
                    <div className="text-[10px] text-accent-text mt-1 max-w-[9rem] leading-tight">{gradeNote}</div>
                  )}
                </div>
                <div className="text-center">
                  <div className="text-5xl font-bold">{scorePct}%</div>
                  <div className="text-xs text-accent-text mt-1 uppercase tracking-wide">Score</div>
                </div>
                <div className="text-center">
                  <div className="text-3xl font-bold">
                    {Math.round(exam.score ?? 0)}
                    <span className="text-lg text-accent-text">/{exam.totalMarks}</span>
                  </div>
                  <div className="text-xs text-accent-text mt-1 uppercase tracking-wide">Marks</div>
                </div>
                {/* The target line. A grade on its own says where the student
                    landed; this says where they were aiming and what the gap
                    is in the only unit they can act on -- marks. */}
                {exam.targetProgress && (
                  <div className="max-w-[11rem] border-l border-white/25 pl-6 text-left">
                    <div className="text-xs uppercase tracking-wide text-accent-text">
                      Target {exam.targetProgress.target.grade}
                    </div>
                    <div className="mt-1 text-lg font-bold">
                      {exam.targetProgress.met
                        ? 'Target met'
                        : `${exam.targetProgress.shortfall} ${exam.targetProgress.shortfall === 1 ? 'mark' : 'marks'} short`}
                    </div>
                    <div className="mt-1 text-[11px] leading-tight text-accent-text">
                      Needed {exam.targetProgress.requiredMarks}/{exam.totalMarks}
                      {' '}({exam.targetProgress.target.requiredPercent}%)
                      {exam.targetProgress.target.isFallback
                        ? ' — estimated, no boundaries on file'
                        : exam.targetProgress.target.source === 'published'
                          ? ' — official boundary'
                          : ' — school boundary'}
                    </div>
                  </div>
                )}
              </div>
            )}
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
                <h3 className="text-lg font-bold text-primary">{sectionTitle}</h3>
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
                  <div key={item.id} className="bg-surface rounded-lg border border-line overflow-hidden">
                    <button
                      onClick={() => toggleItem(item.id)}
                      className="w-full flex items-center justify-between gap-4 p-4 text-left hover:bg-surface-hover transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className={`w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 ${
                          full ? 'bg-accent-subtle text-accent-text'
                            : partial ? 'bg-warning-subtle text-warning'
                            : wrong ? 'bg-danger-subtle text-danger'
                            : 'bg-surface-raised text-muted'
                        }`}>
                          {full ? <CheckCircle2 className="w-5 h-5" />
                            : unanswered ? <Clock className="w-5 h-5" />
                            : <XCircle className="w-5 h-5" />}
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-primary truncate">
                            Q{item.number}{item.part || ''}{item.subPart || ''}{' '}
                            <span className="text-muted font-normal">· {item.marks} marks</span>
                          </p>
                          <p className="text-xs text-muted mt-0.5">
                            {unanswered ? 'Not attempted' : `Scored ${item.score ?? 0} / ${item.marks}`}
                          </p>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 text-muted flex-shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    </button>

                    {isOpen && (
                      <div className="px-4 pb-4 pt-1 border-t border-subtle space-y-4">
                        <div>
                          <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Question</p>
                          <div className="text-sm text-primary">
                            <ExamContent
                              content={item.content}
                              strips={item.strips}
                              alt={`Question ${item.number}`}
                            />
                          </div>
                        </div>

                        <div>
                          <p className="text-xs font-semibold text-muted uppercase tracking-wide mb-2">Your answer</p>
                          {item.answer ? (
                            <div className="bg-surface-raised border border-line rounded-lg p-3 text-sm text-primary whitespace-pre-wrap">
                              {item.answer}
                            </div>
                          ) : (
                            <p className="text-sm text-muted italic">No answer submitted.</p>
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
                              <div className="bg-accent-subtle border border-accent-border rounded-lg p-3">
                                <p className="text-xs font-semibold text-accent-text uppercase mb-2">Strengths</p>
                                <ul className="space-y-1">
                                  {item.strengths.map((s, i) => (
                                    <li key={i} className="text-sm text-accent-text flex gap-2">
                                      <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> {s}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            {item.weaknesses?.length > 0 && (
                              <div className="bg-danger-subtle border border-danger-border rounded-lg p-3">
                                <p className="text-xs font-semibold text-danger uppercase mb-2">To improve</p>
                                <ul className="space-y-1">
                                  {item.weaknesses.map((w, i) => (
                                    <li key={i} className="text-sm text-danger flex gap-2">
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
    blue: 'bg-surface-raised text-secondary',
    green: 'bg-accent-subtle text-accent-text',
    amber: 'bg-warning-subtle text-warning',
    purple: 'bg-surface-raised text-secondary',
    indigo: 'bg-surface-raised text-secondary',
  };
  return (
    <div className="bg-surface rounded-lg border border-line p-4 flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${tints[tint]}`}>
        {icon}
      </div>
      <div>
        <p className="text-xl font-bold text-primary">{value}</p>
        <p className="text-xs text-muted">{label}</p>
      </div>
    </div>
  );
}

function FeedbackBlock({ label, icon, tone, children }: { label: string; icon: React.ReactNode; tone: 'green' | 'amber' | 'blue'; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    green: 'bg-accent-subtle border-accent-border text-accent-text',
    amber: 'bg-warning-subtle border-warning-border text-warning',
    blue: 'bg-surface-raised border-line text-secondary',
  };
  return (
    <div className={`rounded-lg border p-3 ${tones[tone]}`}>
      <p className="text-xs font-semibold uppercase tracking-wide mb-2 flex items-center gap-1.5 opacity-80">
        {icon} {label}
      </p>
      <div className="text-sm">{children}</div>
    </div>
  );
}
