'use client';

import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import dynamic from 'next/dynamic';
import Image from 'next/image';
import toast from 'react-hot-toast';
import { Search, Filter, BookOpen, FileText, Eye, Image as ImageIcon, Pencil, CheckCircle2, XCircle, Clock, Trophy, Star, Lock, Lightbulb, Loader2, Brain, AlertCircle } from 'lucide-react';
import FormattedMessage from '../components/FormattedMessage';
import UnlockWidget from './UnlockWidget';
import AiNotice from './AiNotice';
import PreviewNotice from './PreviewNotice';
import CompetitionVault from './CompetitionVault';
import { useScreenContext } from './ScreenContext';
import QuestionScratchpadPanel from './QuestionScratchpadPanel';

const RichTextEditor = dynamic(() => import('./RichTextEditor'), { ssr: false });

const PDF_FILENAME_RE = /^[a-z0-9][a-z0-9_-]*\.pdf$/i;

type Question = {
  id: number;
  paper_id: number;
  number: number;
  part: string;
  sub_part: string;
  content: string;
  latex: string;
  marks: number;
  has_diagram: number;
  diagram_ref: string;
  topic?: string;
  images?: string[];
  year: number;
  session: string;
  paper_number: number;
  variant: number;
  subject_name: string;
  subject_code: string;
  bookmarked?: boolean;
};

type FilterOptions = {
  subjects: Array<{ id: number; code: string; name: string }>;
  years: number[];
  sessions: string[];
  paperNumbers: number[];
  topics?: string[];
};

type Markscheme = {
  content: string;
};

function formatQuestionNumber(question: Question) {
  let number = question.number.toString();
  if (question.part) number += question.part;
  if (question.sub_part) number += `(${question.sub_part})`;
  return number;
}

function formatQuestionCode(question: Question) {
  const syllabus = question.subject_code || '????';
  const session = (question.session || '?').toUpperCase();
  const year = String(question.year ?? '??').slice(-2);
  const paper = question.paper_number ? `P${question.paper_number}${question.variant ? `v${question.variant}` : ''}` : 'P?';
  return `${syllabus}-${session}${year}-${paper}-Q${formatQuestionNumber(question)}`;
}

export default function QuestionsDatabase({
  initialQuestionId = null,
  initialMode = 'browse',
  onQuestionOpened,
}: {
  initialQuestionId?: number | null;
  initialMode?: 'browse' | 'practice';
  onQuestionOpened?: () => void;
}) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [filters, setFilters] = useState<FilterOptions>({
    subjects: [],
    years: [],
    sessions: [],
    paperNumbers: [],
  });
  const [loading, setLoading] = useState(false);
  // Separates "the bank is empty" from "the bank failed to load".
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedSubject, setSelectedSubject] = useState<string>('');
  const [selectedYear, setSelectedYear] = useState<string>('');
  const [selectedSession, setSelectedSession] = useState<string>('');
  const [selectedPaper, setSelectedPaper] = useState<string>('');
  const [selectedTopic, setSelectedTopic] = useState<string>('');
  const [onlyBookmarked, setOnlyBookmarked] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [selectedQuestion, setSelectedQuestion] = useState<Question | null>(null);
  const [markscheme, setMarkscheme] = useState<Markscheme | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [scope, setScope] = useState<'enrolled' | 'all'>('enrolled');
  const [paperImages, setPaperImages] = useState<string[]>([]);

  // Practice mode state
  const [mode, setMode] = useState<'browse' | 'practice'>(initialMode);

  const [uploadedImageUrl, setUploadedImageUrl] = useState<string | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  // Vault state — STEP/competition questions shown only after easter-egg unlock.
  const [vaultUnlocked, setVaultUnlocked] = useState(false);
  const [showVault, setShowVault] = useState(false);
  // Top search box (free-text across question code + topic).
  const [searchBox, setSearchBox] = useState('');
  const [answer, setAnswer] = useState('');
  const [grade, setGrade] = useState<{
    isCorrect: boolean | null;
    score: number | null;
    maxScore: number | null;
    strengths?: string[];
    weaknesses?: string[];
    explanation?: string;
    modelAnswer?: string;
    gradingStatus?: 'official' | 'provisional' | 'ungraded';
    gradingSourceId?: number | null;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /**
   * Why an attempt came back unscored.
   *
   * /api/practice has always returned `aiNotices` -- for a missing key, a
   * failed grade, an unreadable diagram -- and no client has ever read it. A
   * student with AI switched off submitted an answer, got an empty grade, and
   * was told nothing at all, under a header promising "AI grading + feedback".
   */
  const [aiNotices, setAiNotices] = useState<string[]>([]);
  const [recentAttempts, setRecentAttempts] = useState<Array<{ id: string; score: number | null; maxScore: number | null; isCorrect: boolean | null; attemptedAt: string }>>([]);
  const [hints, setHints] = useState<Array<{ level: number; text: string; grounded: boolean }>>([]);
  const [hintLoading, setHintLoading] = useState(false);
  const [hintError, setHintError] = useState<string | null>(null);

  const [feedbackView, setFeedbackView] = useState<'ai' | 'markscheme' | 'split'>('ai');

  const openPaperPdfFromSearch = () => {
    const filename = searchBox.trim();
    if (!PDF_FILENAME_RE.test(filename)) return false;

    const url = `/api/papers/pdf?filename=${encodeURIComponent(filename)}`;
    const pdfTab = window.open(url, '_blank', 'noopener,noreferrer');
    if (pdfTab) pdfTab.opener = null;
    return true;
  };

  // Check competition vault unlock status on mount.
  useEffect(() => {
    const stored = window.localStorage.getItem('scope:practice');
    if (stored === 'all' || stored === 'enrolled') window.setTimeout(() => setScope(stored), 0);
  }, []);

  const changeScope = (next: 'enrolled' | 'all') => {
    setScope(next);
    window.localStorage.setItem('scope:practice', next);
    setPage(1);
  };

  useEffect(() => {
    fetch('/api/unlock').then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (d?.competition) setVaultUnlocked(true);
    }).catch(() => {});
  }, []);

  const fetchFilters = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (selectedSubject) params.append('subject', selectedSubject);
      params.set('scope', scope);
      const res = await fetch(`/api/questions?action=filters&${params}`);
      if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
      const data = await res.json();

      // Guard against malformed responses so a failed request can't nullify
      // `filters.subjects` and crash the render (filters.subjects.map).
      if (data && Array.isArray(data.subjects)) {
        setFilters({
          subjects: data.subjects,
          years: Array.isArray(data.years) ? data.years : [],
          sessions: Array.isArray(data.sessions) ? data.sessions : [],
          paperNumbers: Array.isArray(data.paperNumbers) ? data.paperNumbers : [],
          topics: Array.isArray(data.topics) ? data.topics : [],
        });
      }
    } catch (error) {
      console.error('Failed to fetch filters:', error);
    }
  }, [scope, selectedSubject]);

  // Re-fetch filters (for the topic list) when the subject changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Refresh remote filter state when its subject key changes.
    void fetchFilters();
  }, [fetchFilters]);

  const fetchQuestions = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        action: 'questions',
        page: page.toString(),
        limit: '20',
        scope,
      });

      if (selectedSubject) params.append('subject', selectedSubject);
      if (selectedYear) params.append('year', selectedYear);
      if (selectedSession) params.append('session', selectedSession);
      if (selectedPaper) params.append('paper', selectedPaper);
      if (selectedTopic) params.append('topic', selectedTopic);
      if (onlyBookmarked) params.append('bookmarked', '1');
      if (searchBox.trim()) params.append('q', searchBox.trim());

      const res = await fetch(`/api/questions?${params}`);
      if (!res.ok) {
        // Without this the bank rendered its "no questions match" empty state
        // for server errors too, so a broken backend looked like a working one
        // with nothing in it.
        const data = await res.json().catch(() => null);
        setQuestions([]);
        setLoadError(
          res.status === 401
            ? 'Sign in to browse the question bank.'
            : data?.error ?? 'The question bank could not be loaded. Please try again.',
        );
        return;
      }
      const data = await res.json();

      setLoadError(null);
      setQuestions(data.questions || []);
      setTotalPages(data.totalPages || 1);
    } catch (error) {
      console.error('Failed to fetch questions:', error);
      setQuestions([]);
      setLoadError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [onlyBookmarked, page, scope, searchBox, selectedPaper, selectedSession, selectedSubject, selectedTopic, selectedYear]);

  // Load questions when filters change.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Refresh remote question state when its query key changes.
    void fetchQuestions();
  }, [fetchQuestions]);

  useEffect(() => {
    // Navigation commands can switch an already-mounted practice view.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(initialMode);
  }, [initialMode]);

  const screenCtx = useScreenContext();

  const viewQuestion = async (question: Question) => {
    setSelectedQuestion(question);
    setMarkscheme(null);
    setPaperImages([]);
    setAnswer('');
    setGrade(null);
    setSubmitError(null);
    setUploadedImageUrl(null);
    setOcrError(null);
    setHints([]);
    setHintError(null);

    // Update screen context so the AI assistant knows what question is open.
    screenCtx.update({
      tab: 'practice',
      description: `Viewing question ${formatQuestionCode(question)} in Practice`,
      data: {
        questionId: question.id,
        questionCode: formatQuestionCode(question),
        questionTopic: question.topic && question.topic !== 'General' ? question.topic : undefined,
        questionSubject: question.subject_name,
        questionText: question.content?.slice(0, 500),
        questionMarks: question.marks > 0 ? question.marks : undefined,
        subjectCode: question.subject_code,
        practiceMode: mode,
      },
    });

    // Fetch markscheme (also returns per-question images)
    try {
      const res = await fetch(`/api/questions?action=question&id=${question.id}`);
      const data = await res.json();
      setMarkscheme(data.markscheme);
      // Use per-question images from the API (coordinate-linked), fall back to
      // the list-level images if present, then to the legacy paper-pattern fetch.
      const qImages = data.question?.images || question.images || [];
      if (qImages.length > 0) {
        setPaperImages(qImages);
      } else if (question.has_diagram === 1) {
        // Legacy fallback: fetch all images for this paper by pattern
        const imagePattern = `${question.subject_code}_${question.session}${question.year}_${question.paper_number}v${question.variant}`;
        try {
          const imgRes = await fetch(`/api/images?pattern=${imagePattern}`);
          const imgData = await imgRes.json();
          setPaperImages(imgData.images || []);
        } catch (error) {
          console.error('Failed to fetch images:', error);
        }
      }
    } catch (error) {
      console.error('Failed to fetch markscheme:', error);
    }

    // Fetch this user's recent attempts on the question (for practice mode)
    try {
      const res = await fetch('/api/practice?page=1&limit=5');
      if (res.ok) {
        const data = await res.json();
        type RawAttempt = {
          id: string;
          questionId: number;
          score: number | null;
          maxScore: number | null;
          isCorrect: boolean;
          attemptedAt: string;
        };
        const filtered: typeof recentAttempts = (data.attempts || [])
          .filter((a: RawAttempt) => a.questionId === question.id)
          .map((a: RawAttempt) => ({
            id: a.id,
            score: a.score ?? 0,
            maxScore: a.maxScore ?? null,
            isCorrect: a.isCorrect,
            attemptedAt: a.attemptedAt,
          }));
        setRecentAttempts(filtered);
      }
    } catch {
      // ignore — not logged in, etc.
    }
  };

  useEffect(() => {
    if (!initialQuestionId) return;
    let cancelled = false;
    fetch(`/api/questions?action=question&id=${initialQuestionId}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('Question could not be opened.');
        return res.json();
      })
      .then((data) => {
        if (cancelled || !data.question) return;
        setMode('practice');
        void viewQuestion(data.question as Question);
        onQuestionOpened?.();
      })
      .catch((error) => {
        if (!cancelled) setSubmitError(error instanceof Error ? error.message : 'Question could not be opened.');
      });
    return () => { cancelled = true; };
    // `viewQuestion` intentionally uses the current practice state when a new ID arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestionId, onQuestionOpened]);

  const requestHint = async () => {
    if (!selectedQuestion || hintLoading || hints.length >= 3) return;
    const level = hints.length + 1;
    setHintLoading(true);
    setHintError(null);
    try {
      const res = await fetch('/api/ai/hint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId: selectedQuestion.id,
          level,
          studentAnswer: answer || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Hint could not be generated.');
      setHints((current) => [...current, { level, text: data.hint, grounded: data.grounded }]);
    } catch (error) {
      setHintError(error instanceof Error ? error.message : 'Hint could not be generated.');
    } finally {
      setHintLoading(false);
    }
  };

  const submitAnswer = async () => {
    if (!selectedQuestion || !answer.trim() || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setGrade(null);
    setAiNotices([]);
    const t0 = Date.now();

    try {
      const res = await fetch('/api/practice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId: selectedQuestion.id,
          answer,
          // Any scratchpad drawing is picked up server-side by question ref
          // (QuestionScratchpadPanel autosaves it independently of submit).
          image: uploadedImageUrl,
          timeSpent: Math.round((Date.now() - t0) / 1000),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to grade answer');
      }
      setGrade(data.attempt);
      if (Array.isArray(data.aiNotices) && data.aiNotices.length > 0) {
        setAiNotices(data.aiNotices);
      }
      setRecentAttempts((prev) => [
        {
          id: data.attempt.id,
          score: data.attempt.score ?? 0,
          maxScore: data.attempt.maxScore ?? null,
          isCorrect: data.attempt.isCorrect,
          attemptedAt: data.attempt.attemptedAt,
        },
        ...prev,
      ]);

      if (data.reviewItemCreated) {
        const count = typeof data.reviewQueueCount === 'number' ? data.reviewQueueCount : null;
        toast(
          (t) => (
            <div className="flex items-center gap-3">
              <Brain className="w-5 h-5 text-emerald-600 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-semibold">Added to your review queue{count ? ` (${count} due)` : ''}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400">See it in Study → Review</p>
              </div>
              <button
                onClick={() => {
                  toast.dismiss(t.id);
                  window.dispatchEvent(new CustomEvent('ai-navigate', { detail: { tab: 'study', view: 'review' } }));
                }}
                className="text-xs font-semibold text-emerald-600 hover:text-emerald-700 flex-shrink-0"
              >
                Review now
              </button>
            </div>
          ),
          { icon: null },
        );
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleImageUpload = async (file: File) => {
    setOcrError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.fileUrl) throw new Error(data.error || 'Upload failed');
      setUploadedImageUrl(data.fileUrl);
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  const transcribeImage = async () => {
    const imageUrl = uploadedImageUrl;
    if (!imageUrl || !selectedQuestion || ocrLoading) return;
    setOcrLoading(true);
    setOcrError(null);
    try {
      const res = await fetch('/api/practice/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: imageUrl, questionId: selectedQuestion.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Transcription failed');
      const transcript = (data.text || '').trim();
      if (!transcript) throw new Error('No text detected in the image');
      setAnswer((prev) => {
        const stamp = '\n\n[Transcribed from handwritten work]\n';
        return prev.trim() ? `${prev.trim()}${stamp}${transcript}` : transcript;
      });
      toast.success('Transcription added — review and edit before submitting.');
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : 'Transcription failed');
    } finally {
      setOcrLoading(false);
    }
  };

  // Toggle the bookmark/star on the currently-selected question.
  const toggleBookmark = async (question: Question) => {
    const prevBookmarked = question.bookmarked;
    // Optimistically update the selected question + the list row.
    const patch = (q: Question) => ({ ...q, bookmarked: !prevBookmarked });
    setSelectedQuestion((cur) => (cur && cur.id === question.id ? patch(cur) : cur));
    setQuestions((cur) => cur.map((q) => (q.id === question.id ? patch(q) : q)));

    try {
      if (prevBookmarked) {
        await fetch(`/api/bookmarks?questionId=${question.id}`, { method: 'DELETE' });
      } else {
        await fetch('/api/bookmarks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ questionId: question.id }),
        });
      }
    } catch {
      // Revert on failure.
      setSelectedQuestion((cur) => (cur && cur.id === question.id ? patch(cur) : cur));
      setQuestions((cur) => cur.map((q) => (q.id === question.id ? patch(q) : q)));
    }
  };

  const parseMarkschemeContent = (content: string) => {
    try {
      // Try to parse as JSON (some markschemes are in JSON format)
      const parsed = JSON.parse(content);
      if (parsed.marking_points) {
        return (
          <div className="space-y-2">
            {parsed.answer && (
              <div className="mb-3">
                <strong className="text-green-700 dark:text-green-300">Answer: </strong>
                <FormattedMessage content={parsed.answer} />
              </div>
            )}
            {parsed.marking_points.length > 0 && (
              <div>
                <strong className="text-green-700 dark:text-green-300">Marking Points:</strong>
                <ul className="list-disc list-inside mt-2 space-y-1">
                  {parsed.marking_points.map((point: string, idx: number) => (
                    <li key={idx}>
                      <FormattedMessage content={point} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        );
      }
    } catch {
      // Not JSON, just plain text - render as is
    }
    return <FormattedMessage content={content} />;
  };

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-900 relative">
      {/* Easter-egg unlock dot + drawer */}
      <UnlockWidget onUnlocked={() => { setVaultUnlocked(true); setShowVault(true); }} />

      {/* Header */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Practice</h2>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-0.5">
              {showVault ? 'STEP / Competition vault' : 'Browse past-paper questions and switch into practice mode'}
            </p>
          </div>
          <div className="flex items-center space-x-3 flex-shrink-0">
            {/* Vault toggle — only visible once unlocked. */}
            {vaultUnlocked && (
              <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
                <button
                  onClick={() => setShowVault(false)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                    !showVault
                      ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                  }`}
                >
                  Past Papers
                </button>
                <button
                  onClick={() => setShowVault(true)}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-1 ${
                    showVault
                      ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                  }`}
                >
                  <Lock className="w-3 h-3" /> Vault
                </button>
              </div>
            )}
            {/* Past-paper mode toggle — hidden when viewing the vault. */}
            {!showVault && (
              <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-1" role="group" aria-label="Content scope">
                <button onClick={() => changeScope('enrolled')} className={`px-3 py-1.5 rounded-md text-xs font-medium ${scope === 'enrolled' ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-white shadow-sm' : 'text-gray-600 dark:text-gray-400'}`}>My courses</button>
                <button onClick={() => changeScope('all')} className={`px-3 py-1.5 rounded-md text-xs font-medium ${scope === 'all' ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-white shadow-sm' : 'text-gray-600 dark:text-gray-400'}`}>All subjects</button>
              </div>
            )}
            {!showVault && (
              <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
                <button
                  onClick={() => { setMode('browse'); screenCtx.updateData({ practiceMode: 'browse' }); }}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                    mode === 'browse'
                      ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                  }`}
                >
                  Browse
                </button>
                <button
                  onClick={() => { setMode('practice'); screenCtx.updateData({ practiceMode: 'practice' }); }}
                  className={`px-3 py-1.5 rounded-md text-sm font-medium transition-all ${
                    mode === 'practice'
                      ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-white shadow-sm'
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                  }`}
                >
                  Practice
                </button>
              </div>
            )}
            {!showVault && (
              <button
                onClick={() => setShowFilters(!showFilters)}
                className="flex items-center space-x-2 px-4 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
              >
                <Filter className="w-4 h-4" />
                <span>{showFilters ? 'Hide' : 'Filters'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Top search box for past-paper mode */}
        {!showVault && (
          <div className="mt-3 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="search"
              value={searchBox}
              onChange={(e) => { setSearchBox(e.target.value); setPage(1); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && openPaperPdfFromSearch()) {
                  e.preventDefault();
                }
              }}
              placeholder="Search by question code (e.g. 0610-S25-P21-Q2) or topic (e.g. Inheritance)…"
              className="w-full pl-9 pr-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
        )}

        {!showVault && mode === 'practice' && (
          /* Says "if you have added a key" rather than promising AI grading
             outright: AI is off by default for every new account, and this
             line sat directly above an empty grade with no explanation. */
          <p className="mt-2 text-xs text-green-700 dark:text-green-300">
            Practice mode: pick a question, write your answer, and submit. It is
            marked automatically if you have added an API key, and saved against
            the mark scheme either way. Sign in to track progress.
          </p>
        )}
        {/* The vault is separate content, so the bank's readiness notice does
            not apply there. */}
        {!showVault && <PreviewNotice feature="question-bank" className="mt-3" />}
      </div>

      {/* Competition vault view (replaces the past-paper body when active) */}
      {showVault ? (
        <div className="flex-1 overflow-hidden">
          <CompetitionVault />
        </div>
      ) : (
        <Fragment>
          <div className="flex-1 flex overflow-hidden">
        {/* Filters Sidebar */}
        {showFilters && (
          <div className="w-80 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 p-6 overflow-y-auto">
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4">Filters</h3>

            {/* Subject Filter */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Subject</label>
              <select
                value={selectedSubject}
                onChange={(e) => { setSelectedSubject(e.target.value); setSelectedTopic(''); setPage(1); }}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 dark:bg-gray-700 dark:text-white"
              >
                <option value="">All Subjects</option>
                {filters.subjects.map((subject) => (
                  <option key={subject.id} value={subject.id}>
                    {subject.name} ({subject.code})
                  </option>
                ))}
              </select>
            </div>

            {/* Year Filter */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Year</label>
              <select
                value={selectedYear}
                onChange={(e) => { setSelectedYear(e.target.value); setPage(1); }}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 dark:bg-gray-700 dark:text-white"
              >
                <option value="">All Years</option>
                {filters.years.map((year) => (
                  <option key={year} value={year}>{year}</option>
                ))}
              </select>
            </div>

            {/* Session Filter */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Session</label>
              <select
                value={selectedSession}
                onChange={(e) => { setSelectedSession(e.target.value); setPage(1); }}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 dark:bg-gray-700 dark:text-white"
              >
                <option value="">All Sessions</option>
                {filters.sessions.map((session) => (
                  <option key={session} value={session}>{session}</option>
                ))}
              </select>
            </div>

            {/* Paper Number Filter */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Paper</label>
              <select
                value={selectedPaper}
                onChange={(e) => { setSelectedPaper(e.target.value); setPage(1); }}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 dark:bg-gray-700 dark:text-white"
              >
                <option value="">All Papers</option>
                {filters.paperNumbers.map((paper) => (
                  <option key={paper} value={paper}>Paper {paper}</option>
                ))}
              </select>
            </div>

            {/* Topic Filter */}
            {filters.topics && filters.topics.length > 0 && (
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Topic / Sub-subject</label>
                <select
                  value={selectedTopic}
                  onChange={(e) => { setSelectedTopic(e.target.value); setPage(1); }}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 dark:bg-gray-700 dark:text-white"
                >
                  <option value="">All Topics</option>
                  {filters.topics.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Bookmarked-only toggle */}
            <div className="mb-6 flex items-center gap-2">
              <input
                id="only-bookmarked"
                type="checkbox"
                checked={onlyBookmarked}
                onChange={(e) => { setOnlyBookmarked(e.target.checked); setPage(1); }}
                className="w-4 h-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
              />
              <label htmlFor="only-bookmarked" className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1 cursor-pointer">
                <Star className="w-3.5 h-3.5" /> Starred only
              </label>
            </div>

            {/* Clear Filters */}
            <button
              onClick={() => {
                setSelectedSubject('');
                setSelectedYear('');
                setSelectedSession('');
                setSelectedPaper('');
                setSelectedTopic('');
                setOnlyBookmarked(false);
                setPage(1);
              }}
              className="w-full px-4 py-2 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors text-sm font-medium"
            >
              Clear All Filters
            </button>
          </div>
        )}

        {/* Main Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Questions List */}
          <div className={`${selectedQuestion ? 'w-2/5' : 'w-full'} border-r border-gray-200 dark:border-gray-700 overflow-y-auto`}>
            {loading ? (
              <div className="flex items-center justify-center h-64">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-500"></div>
              </div>
            ) : loadError ? (
              <div className="flex flex-col items-center justify-center h-64 px-6 text-center text-gray-600 dark:text-gray-400">
                <AlertCircle className="w-12 h-12 mb-4 text-red-500" />
                <p className="font-semibold text-gray-900 dark:text-gray-100">
                  Couldn&apos;t load questions
                </p>
                <p className="mt-1 text-sm max-w-sm">{loadError}</p>
                <button
                  onClick={() => void fetchQuestions()}
                  className="mt-4 px-4 py-2 text-sm font-medium rounded-lg bg-green-600 text-white hover:bg-green-700"
                >
                  Try again
                </button>
              </div>
            ) : questions.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-gray-500 dark:text-gray-400">
                <BookOpen className="w-16 h-16 mb-4" />
                <p>No questions found</p>
                <p className="text-sm">Try adjusting your filters</p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {/* The row is a <button> inside the <li>, not an <li onClick>:
                    a click handler on the list item is unreachable by keyboard,
                    so the question list could not be navigated with Tab/Enter. */}
                {questions.map((question) => (
                  <li key={question.id}>
                  <button
                    type="button"
                    onClick={() => viewQuestion(question)}
                    aria-current={selectedQuestion?.id === question.id}
                    className={`block w-full text-left px-4 py-3 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-green-500 ${
                      selectedQuestion?.id === question.id
                        ? 'bg-green-50 dark:bg-green-900/20 border-l-2 border-green-500'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-800/50 border-l-2 border-transparent'
                    }`}
                  >
                    {/* Row 1: the question code (prominent, monospace) */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {formatQuestionCode(question)}
                      </span>
                      {question.bookmarked && (
                        <Star className="w-3 h-3 text-amber-500 fill-amber-500" />
                      )}
                      {question.marks > 0 && (
                        <span className="text-[10px] text-gray-400">[{question.marks} marks]</span>
                      )}
                    </div>
                    {/* Row 2: labels (topic + subject) */}
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300">
                        {question.subject_name}
                      </span>
                      {question.topic && question.topic !== 'General' && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-300">
                          {question.topic}
                        </span>
                      )}
                      {question.has_diagram === 1 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-50 dark:bg-cyan-900/30 text-cyan-600 dark:text-cyan-300 flex items-center gap-0.5">
                          <Eye className="w-2.5 h-2.5" /> diagram
                        </span>
                      )}
                    </div>
                  </button>
                  </li>
                ))}
              </ul>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center space-x-2 py-4">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="px-4 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Previous
                </button>
                <span className="text-sm text-gray-600 dark:text-gray-400">
                  Page {page} of {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="px-4 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Next
                </button>
              </div>
            )}
          </div>

          {/* Question Detail Panel */}
          {selectedQuestion && (
            <div className="flex-1 overflow-y-auto bg-white dark:bg-gray-800 p-6">
              <div className="mb-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-xl font-bold font-mono text-gray-900 dark:text-white">
                      {formatQuestionCode(selectedQuestion)}
                    </h3>
                    {selectedQuestion.topic && selectedQuestion.topic !== 'General' && (
                      <span className="px-2 py-0.5 bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 rounded text-xs font-medium">
                        {selectedQuestion.topic}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleBookmark(selectedQuestion)}
                      title={selectedQuestion.bookmarked ? 'Remove from starred' : 'Star this question'}
                      className={`p-1.5 rounded-lg transition-colors ${selectedQuestion.bookmarked ? 'text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/20' : 'text-gray-400 hover:text-amber-500 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                    >
                      <Star className={`w-5 h-5 ${selectedQuestion.bookmarked ? 'fill-amber-500' : ''}`} />
                    </button>
                    <button
                      onClick={() => setSelectedQuestion(null)}
                      className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div className="flex items-center space-x-2 text-sm text-gray-600 dark:text-gray-400 mb-4">
                  <span className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded">{selectedQuestion.subject_name}</span>
                  <span>•</span>
                  <span>{selectedQuestion.year}</span>
                  <span>•</span>
                  <span>{selectedQuestion.session}</span>
                  <span>•</span>
                  <span>Paper {selectedQuestion.paper_number}</span>
                  {selectedQuestion.marks > 0 && (
                    <>
                      <span>•</span>
                      <span className="font-medium text-green-600 dark:text-green-400">[{selectedQuestion.marks} marks]</span>
                    </>
                  )}
                </div>

                <div className="prose dark:prose-invert max-w-none">
                  <div className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
                    <FormattedMessage content={selectedQuestion.content} />
                  </div>
                </div>

                {/* Display figures linked to this question */}
                {selectedQuestion.has_diagram === 1 && paperImages.length > 0 && (
                  <div className="mt-4">
                    <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center space-x-2">
                      <ImageIcon className="w-4 h-4" />
                      <span>Figures for this question:</span>
                    </h4>
                    <div className="grid grid-cols-1 gap-4">
                      {paperImages.map((imgUrl, idx) => (
                        <div key={idx} className="border border-gray-300 dark:border-gray-600 rounded-lg overflow-hidden bg-white dark:bg-gray-800 p-2">
                          <Image
                            src={imgUrl}
                            alt={`Figure ${idx + 1}`}
                            width={1200}
                            height={1200}
                            unoptimized
                            className="max-w-full h-auto mx-auto"
                            onError={(e) => { e.currentTarget.parentElement!.style.display = 'none'; }}
                          />
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 text-center">
                            {imgUrl.split('/').pop()}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {selectedQuestion.has_diagram === 1 && paperImages.length === 0 && (
                  <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
                    <p className="text-sm text-blue-800 dark:text-blue-200">
                      📷 This question references a diagram, but no figure has been linked to it yet.
                    </p>
                  </div>
                )}
              </div>

              {/* Practice mode */}
              {mode === 'practice' && (
                <div className="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
                  <div className="mb-5 border border-amber-200 dark:border-amber-900/70 bg-amber-50/70 dark:bg-amber-950/20 rounded-lg p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Lightbulb className="w-4 h-4 text-amber-600" />
                        <h4 className="text-sm font-bold text-gray-900 dark:text-white">Progressive hints</h4>
                      </div>
                      <button
                        onClick={requestHint}
                        disabled={hintLoading || hints.length >= 3}
                        className="h-8 px-3 inline-flex items-center gap-1.5 rounded-lg bg-amber-500 text-white text-xs font-semibold disabled:opacity-50"
                      >
                        {hintLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lightbulb className="w-3.5 h-3.5" />}
                        {hints.length >= 3 ? 'All hints shown' : `Hint ${hints.length + 1} of 3`}
                      </button>
                    </div>
                    {hints.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {hints.map((hint) => (
                          <div key={hint.level} className="p-3 bg-white/80 dark:bg-gray-900/70 border border-amber-100 dark:border-amber-900/50 rounded-md">
                            <p className="text-[10px] font-bold uppercase text-amber-700 dark:text-amber-400 mb-1">Level {hint.level}</p>
                            <FormattedMessage content={hint.text} />
                          </div>
                        ))}
                      </div>
                    )}
                    {hintError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{hintError}</p>}
                  </div>

                  {/* Drawing canvas + photo upload toggle */}
                  <div className="flex items-center justify-between mb-4 gap-2 flex-wrap">
                    <h4 className="text-lg font-bold text-gray-900 dark:text-white flex items-center space-x-2">
                      <Pencil className="w-5 h-5 text-green-500" />
                      <span>Your Answer</span>
                    </h4>
                    <div className="flex items-center gap-2 flex-wrap">
                      {uploadedImageUrl && (
                        <button
                          onClick={transcribeImage}
                          disabled={ocrLoading}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-60 transition-all"
                        >
                          {ocrLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lightbulb className="w-4 h-4" />}
                          {ocrLoading ? 'Transcribing…' : 'Transcribe'}
                        </button>
                      )}
                      <button
                        onClick={() => imageInputRef.current?.click()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-all"
                      >
                        <ImageIcon className="w-4 h-4" />
                        Upload photo
                      </button>
                      <input
                        ref={imageInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleImageUpload(f);
                          e.target.value = '';
                        }}
                      />
                    </div>
                  </div>

                  <AiNotice notices={aiNotices} className="mb-3" />

                  {ocrError && (
                    <div className="mb-3 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-300">
                      {ocrError}
                    </div>
                  )}

                  {uploadedImageUrl && (
                    <div className="mb-3 flex items-center gap-3 p-2.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={uploadedImageUrl} alt="Uploaded answer" className="w-16 h-16 object-cover rounded-md border border-gray-200 dark:border-gray-700" />
                      <div className="flex-1 min-w-0 text-xs text-gray-600 dark:text-gray-400">
                        <p className="font-semibold text-gray-700 dark:text-gray-300">Photo attached</p>
                        <p>Transcribe it or submit as-is.</p>
                      </div>
                      <button onClick={() => setUploadedImageUrl(null)} className="text-xs font-medium text-red-600 hover:text-red-700">Remove</button>
                    </div>
                  )}

                  <QuestionScratchpadPanel
                    questionRef={{ pastPaperQuestionId: selectedQuestion.id }}
                    className="mb-4"
                  />

                  <RichTextEditor
                    content={answer}
                    onChange={setAnswer}
                    placeholder="Explain your steps and use Σ for LaTeX math."
                  />

                  <div className="mt-3 flex items-center justify-between">
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {answer.trim().length === 0
                        ? 'Write something to get AI feedback.'
                        : `${answer.trim().length} chars`}
                    </p>
                    <button
                      onClick={submitAnswer}
                      disabled={submitting || answer.trim().length === 0}
                      className="px-5 py-2 bg-gradient-to-r from-green-500 to-emerald-500 text-white rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:shadow-lg transition-all"
                    >
                      {submitting ? 'Grading…' : 'Submit & Grade'}
                    </button>
                  </div>

                  {submitError && (
                    <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
                      {submitError}
                    </div>
                  )}

                  {(grade || markscheme) && (
                    <div className="mt-6 space-y-4">
                      {grade && (
                        <div className={`inline-flex rounded px-2 py-1 text-xs font-semibold ${grade.gradingStatus === 'official' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300'}`}>
                          {grade.gradingStatus === 'official' ? 'Official mark-scheme grading' : grade.gradingStatus === 'ungraded' ? 'Ungraded attempt' : 'Provisional AI feedback'}
                        </div>
                      )}
                      {grade && markscheme && (
                        <div className="inline-flex items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-0.5 text-xs font-semibold">
                          {(['ai', 'markscheme', 'split'] as const).map((v) => (
                            <button
                              key={v}
                              onClick={() => setFeedbackView(v)}
                              className={`px-2.5 py-1 rounded-md transition-colors ${feedbackView === v ? 'bg-white dark:bg-gray-900 text-emerald-700 dark:text-emerald-300 shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`}
                            >
                              {v === 'ai' ? 'AI feedback' : v === 'markscheme' ? 'Mark scheme' : 'Both'}
                            </button>
                          ))}
                        </div>
                      )}
                      {feedbackView === 'split' && grade && markscheme ? (
                        <div className="grid gap-4 lg:grid-cols-2">
                          <div>
                            <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">AI explanation</h5>
                            <div className={`p-4 rounded-lg border ${grade.isCorrect ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'}`}>
                              <span className="font-semibold text-gray-900 dark:text-white">Score: {grade.score ?? 0}{grade.maxScore ? ` / ${grade.maxScore}` : ''} marks</span>
                            </div>
                            {grade.explanation && (
                              <div className="mt-2 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg text-sm">
                                <FormattedMessage content={grade.explanation} />
                              </div>
                            )}
                          </div>
                          <div>
                            <h5 className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">Official mark scheme</h5>
                            <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800 prose dark:prose-invert max-w-none">
                              {parseMarkschemeContent(markscheme.content)}
                            </div>
                          </div>
                        </div>
                      ) : feedbackView === 'markscheme' && markscheme && !grade ? (
                        <div className="prose dark:prose-invert max-w-none">
                          <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
                            {parseMarkschemeContent(markscheme.content)}
                          </div>
                        </div>
                      ) : grade ? (
                        <div>
                          <div className={`p-4 rounded-lg border ${grade.isCorrect ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'}`}>
                            <span className="font-semibold text-gray-900 dark:text-white">Score: {grade.score ?? 0}{grade.maxScore ? ` / ${grade.maxScore}` : ''} marks</span>
                          </div>
                          {grade.strengths && grade.strengths.length > 0 && (
                            <div className="mt-3">
                              <h5 className="text-sm font-semibold text-green-700 dark:text-green-300 mb-2">What you did well</h5>
                              <ul className="list-disc list-inside space-y-1 text-sm text-gray-700 dark:text-gray-300">
                                {grade.strengths.map((s, i) => <li key={i}><FormattedMessage content={s} /></li>)}
                              </ul>
                            </div>
                          )}
                          {grade.weaknesses && grade.weaknesses.length > 0 && (
                            <div className="mt-3">
                              <h5 className="text-sm font-semibold text-amber-700 dark:text-amber-300 mb-2">What to improve</h5>
                              <ul className="list-disc list-inside space-y-1 text-sm text-gray-700 dark:text-gray-300">
                                {grade.weaknesses.map((w, i) => <li key={i}><FormattedMessage content={w} /></li>)}
                              </ul>
                            </div>
                          )}
                          {grade.explanation && (
                            <div className="mt-3">
                              <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Explanation</h5>
                              <div className="p-3 bg-gray-50 dark:bg-gray-900 rounded-lg text-sm">
                                <FormattedMessage content={grade.explanation} />
                              </div>
                            </div>
                          )}
                          {grade.modelAnswer && (
                            <div className="mt-3">
                              <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Model answer</h5>
                              <div className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-sm">
                                <FormattedMessage content={grade.modelAnswer} />
                              </div>
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  )}

                  {recentAttempts.length > 0 && !grade && (
                    <div className="mt-6">
                      <h5 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center space-x-2">
                        <Trophy className="w-4 h-4 text-yellow-500" />
                        <span>Your previous attempts</span>
                      </h5>
                      <div className="space-y-1">
                        {recentAttempts.map((a) => (
                          <div key={a.id} className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400 p-2 bg-gray-50 dark:bg-gray-900 rounded">
                            <span className="flex items-center space-x-2">
                              {a.isCorrect ? <CheckCircle2 className="w-3 h-3 text-green-500" /> : <XCircle className="w-3 h-3 text-amber-500" />}
                              <span>{a.score}{a.maxScore ? ` / ${a.maxScore}` : ''}</span>
                            </span>
                            <span className="flex items-center space-x-1">
                              <Clock className="w-3 h-3" />
                              {new Date(a.attemptedAt).toLocaleString()}
                            </span>
                          </div>
                        ))}
                      </div>
                </div>
              )}
            </div>
          )}
            </div>
          )}
            </div>
        </div>
        </Fragment>
      )}
    </div>
  );
}
