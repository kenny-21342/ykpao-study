"use client";

import { useState, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import { useSession, signOut } from 'next-auth/react';
import toast from 'react-hot-toast';
import Link from 'next/link';
import ThemeToggle from './components/ThemeToggle';
import FloatingAIAssistant from './components/FloatingAIAssistant';
import OnboardingWizard from './components/OnboardingWizard';
import QuestionsDatabase from './components/QuestionsDatabase';
import MockExams from './components/MockExams';
import DiscussionBoard from './components/DiscussionBoard';
import NotificationBell from './components/NotificationBell';
import StudyCoach from './components/StudyCoach';
import MaterialsHub from './components/MaterialsHub';
import DailyChallenge from './components/DailyChallenge';
import TrendingNotes from './components/TrendingNotes';
import AnnouncementBanner from './components/AnnouncementBanner';
import { ScreenContextProvider, useScreenContext } from './components/ScreenContext';
import {
  BookOpen, Database, Sparkles, TrendingUp,
  Clock, Award, Target, Star, User, Settings,
  LogOut, Home, FileText, Zap,
  BookMarked, GraduationCap, BarChart3, Calendar, LogIn,
  PanelLeftClose, PanelLeft, ClipboardList, Library, MessagesSquare,
  ShieldCheck, Brain, ArrowRight, Layers3, Menu, X,
} from 'lucide-react';

type StudyCoachView = 'today' | 'plan' | 'mistakes' | 'review' | 'mastery' | 'search';
type PracticeMode = 'browse' | 'practice';
type MainTab = 'dashboard' | 'study' | 'practice' | 'materials' | 'mock-exams' | 'discussions';

type RoutedTab = {
  tab: MainTab;
  studyView?: StudyCoachView;
  practiceMode?: PracticeMode;
  questionId?: number | null;
};

type DashboardStats = {
  questionsAnswered: number;
  accuracy: number;
  studyStreak: number;
  hoursStudied: number;
  bookmarkCount: number;
  noteCount: number;
  thisWeek: number;
  lastWeek: number;
  weekDelta: number;
  nudges: Array<{ type: 'reviews' | 'stalled' | 'corpus'; count: number; label: string; action: 'review' | 'plan' | 'practice' }>;
};

type PlatformStats = {
  questions: number;
  subjects: number;
  pastPapers: number;
  resources: number;
  mockExams: number;
};

type ActivityItem = {
  subject: string;
  questions: number;
  accuracy: number;
  time: string;
  timeLabel: string;
};

type LearningOverview = {
  todayTasks: Array<{
    id: string;
    title: string;
    subject: string;
    topic: string;
    durationMinutes: number;
    status: string;
    dueAt: string;
    questionId: number | null;
    taskType: string;
  }>;
  overdueTasks: Array<{
    id: string;
    title: string;
    subject: string;
    topic: string;
    durationMinutes: number;
    status: string;
    dueAt: string;
    questionId: number | null;
    taskType: string;
  }>;
  dueReviews: number;
  adaptiveQueue: Array<{
    questionId: number;
    subject: string;
    topic: string;
    title: string;
    reason: string;
    kind: string;
    marks?: number;
    code?: string;
  }>;
  summary: {
    topicsStarted: number;
    topicsMastered: number;
    tasksDue: number;
    activeReviews: number;
  };
  latestExam: { id: string; title: string; score: number | null; totalMarks: number; submittedAt: string | null } | null;
};

type StatTone = 'blue' | 'green' | 'orange' | 'purple';

const statToneStyles: Record<StatTone, { icon: string; helper: string }> = {
  blue: { icon: 'bg-blue-50 text-blue-600', helper: 'text-blue-600' },
  green: { icon: 'bg-green-50 text-green-600', helper: 'text-green-600' },
  orange: { icon: 'bg-orange-50 text-orange-600', helper: 'text-orange-600' },
  purple: { icon: 'bg-purple-50 text-purple-600', helper: 'text-purple-600' },
};

const formatStat = (value: number | undefined, suffix = '') => {
  if (value === undefined) return '...';
  return `${new Intl.NumberFormat('en-US').format(value)}${suffix}`;
};

const formatRelativeActivityTime = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.max(0, Math.floor(diff / 60000));
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const resolveRoute = (raw: string | null): RoutedTab | null => {
  switch (raw) {
    case 'dashboard':
      return { tab: 'dashboard' };
    case 'daily':
      return { tab: 'dashboard' };
    case 'study':
    case 'study-coach':
      return { tab: 'study' };
    case 'practice':
    case 'questions-db':
      return { tab: 'practice' };
    case 'materials':
    case 'notes-textbook':
    case 'resources':
      return { tab: 'materials' };
    case 'mock-exams':
      return { tab: 'mock-exams' };
    case 'discussions':
      return { tab: 'discussions' };
    case 'weaknesses':
      return { tab: 'study', studyView: 'mastery' };
    default:
      return null;
  }
};

export default function SmartEduPlatform() {
  const { data: session, status } = useSession();
  const [activeTab, setActiveTab] = useState<MainTab>('dashboard');
  const [pendingQuestionId, setPendingQuestionId] = useState<number | null>(null);
  const [studyStartView, setStudyStartView] = useState<StudyCoachView>('today');
  const [practiceStartMode, setPracticeStartMode] = useState<PracticeMode>('browse');
  const [isAccountOpen, setIsAccountOpen] = useState(false);
  const [isAIAssistantOpen, setIsAIAssistantOpen] = useState(false);
  const [learningOverview, setLearningOverview] = useState<LearningOverview | null>(null);

  // Below `lg` the sidebar is an off-canvas drawer rather than a column, so it
  // needs its own open/closed state independent of the desktop collapse.
  // Declared before `openRoute`, which closes the drawer on navigation.
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);

  const openRoute = useCallback((route: RoutedTab) => {
    if (route.tab === 'study') {
      setStudyStartView(route.studyView ?? 'today');
      setPendingQuestionId(null);
    } else if (route.tab === 'practice') {
      setPracticeStartMode(route.practiceMode ?? (route.questionId ? 'practice' : 'browse'));
      setPendingQuestionId(route.questionId ?? null);
    } else {
      setPendingQuestionId(null);
    }
    setActiveTab(route.tab);
    // Navigating from the drawer should dismiss it, or the destination stays
    // hidden behind the overlay on a phone.
    setIsMobileNavOpen(false);
  }, []);

  // Escape closes the mobile navigation drawer.
  useEffect(() => {
    if (!isMobileNavOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsMobileNavOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMobileNavOpen]);

  useEffect(() => {
    const openAIAssistant = () => setIsAIAssistantOpen(true);
    const navigateFromAI = (event: Event) => {
      const detail = (event as CustomEvent<{ tab?: string; questionId?: number; view?: StudyCoachView }>).detail;
      const route = resolveRoute(detail?.tab ?? null);
      if (!route) return;
      setIsAIAssistantOpen(false);
      if (route.tab === 'study') {
        openRoute({ tab: 'study', studyView: detail?.view ?? route.studyView ?? 'today' });
        return;
      }
      if (route.tab === 'practice') {
        openRoute({
          tab: 'practice',
          questionId: detail?.questionId ?? route.questionId ?? null,
          practiceMode: detail?.questionId ? 'practice' : 'browse',
        });
        return;
      }
      openRoute(route);
    };
    window.addEventListener('open-ai-assistant', openAIAssistant);
    window.addEventListener('ai-navigate', navigateFromAI);
    return () => {
      window.removeEventListener('open-ai-assistant', openAIAssistant);
      window.removeEventListener('ai-navigate', navigateFromAI);
    };
  }, [openRoute]);

  const user = session?.user;
  const isAuthenticated = status === 'authenticated';
  const userInitials = user?.name
    ? user.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
    : user?.email?.[0]?.toUpperCase() ?? 'YS';

  const [isMainSidebarCollapsed, setIsMainSidebarCollapsed] = useState(false);
  // User-customizable background image (fetched from /api/account via session).
  const [bgImage, setBgImage] = useState<string | null>(null);

  // Onboarding wizard — show once for users who haven't completed it.
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Bumped to force a dashboard refresh (e.g. after onboarding completes).
  const [refreshTick, setRefreshTick] = useState(0);

  // Real dashboard stats for signed-in users; public platform totals for guests.
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [platformStats, setPlatformStats] = useState<PlatformStats | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/platform-stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setPlatformStats({
            questions: data.questions ?? 0,
            subjects: data.subjects ?? 0,
            pastPapers: data.pastPapers ?? 0,
            resources: data.resources ?? 0,
            mockExams: data.mockExams ?? 0,
          });
        }
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!isAuthenticated) {
      return;
    }

    let cancelled = false;
    Promise.all([
      fetch('/api/dashboard').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/learning/overview').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/onboarding').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([data, overview, onb]) => {
      if (cancelled) return;
      if (data) {
        setStats({
          questionsAnswered: data.questionsAnswered ?? 0,
          accuracy: data.accuracy ?? 0,
          studyStreak: data.studyStreak ?? 0,
          hoursStudied: data.hoursStudied ?? 0,
          bookmarkCount: data.bookmarkCount ?? 0,
          noteCount: data.noteCount ?? 0,
          thisWeek: data.thisWeek ?? 0,
          lastWeek: data.lastWeek ?? 0,
          weekDelta: data.weekDelta ?? 0,
          nudges: Array.isArray(data.nudges) ? data.nudges : [],
        });
        setActivity(Array.isArray(data.recentActivity)
          ? data.recentActivity.map((item: Omit<ActivityItem, 'timeLabel'>) => ({
              ...item,
              timeLabel: formatRelativeActivityTime(item.time),
            }))
          : []);
      }
      if (overview) {
        setLearningOverview(overview);
      }
      if (onb && onb.onboarded === false) {
        setShowOnboarding(true);
      }
    });
    return () => { cancelled = true; };
  }, [isAuthenticated, refreshTick]);

  // Allow child components (e.g. NotificationBell) to switch tabs without
  // prop drilling a setter through the whole tree.
  // Passes an optional threadId/entityId so discussions can auto-open it.
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);
  useEffect(() => {
    const onOpenDiscussions = (e: Event) => {
      openRoute({ tab: 'discussions' });
      const detail = (e as CustomEvent).detail;
      if (detail?.threadId) {
        setPendingThreadId(detail.threadId);
      }
    };
    const onOpenNotes = () => openRoute({ tab: 'materials' });
    window.addEventListener('open-discussions', onOpenDiscussions as EventListener);
    window.addEventListener('open-notes', onOpenNotes as EventListener);
    return () => {
      window.removeEventListener('open-discussions', onOpenDiscussions as EventListener);
      window.removeEventListener('open-notes', onOpenNotes as EventListener);
    };
  }, [openRoute]);

  // Fetch the user's custom background image (if any) once authenticated.
  useEffect(() => {
    if (!isAuthenticated) return;

    let cancelled = false;
    fetch('/api/account')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setBgImage(d?.user?.bgImage ?? null);
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [isAuthenticated]);

  const visibleBgImage = isAuthenticated ? bgImage : null;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);

      // app/admin/layout.tsx and app/v3/layout.tsx redirect here with
      // ?admin=forbidden when a non-admin reaches an admin route. Nothing used
      // to read it, so those users were silently bounced to the dashboard with
      // no idea why the link they clicked did nothing.
      if (params.get('admin') === 'forbidden') {
        toast.error('You need administrator access to open that page.');
        const cleaned = new URLSearchParams(window.location.search);
        cleaned.delete('admin');
        const query = cleaned.toString();
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${query ? `?${query}` : ''}`,
        );
      }

      const route = resolveRoute(params.get('tab'));
      const requestedView = params.get('view') as StudyCoachView | null;
      const questionId = Number(params.get('qid'));
      if (route) {
        const validStudyViews = new Set<StudyCoachView>(['today', 'plan', 'mistakes', 'review', 'mastery', 'search']);
        openRoute({
          ...route,
          studyView: requestedView && validStudyViews.has(requestedView) ? requestedView : route.studyView,
          questionId: Number.isInteger(questionId) && questionId > 0 ? questionId : route.questionId,
          practiceMode: params.get('mode') === 'practice' ? 'practice' : route.practiceMode,
        });
      } else if (Number.isInteger(questionId) && questionId > 0) {
        openRoute({ tab: 'practice', questionId, practiceMode: 'practice' });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [openRoute]);

  useEffect(() => {
    if (window.location.pathname === '/' && window.location.hash === '#announcements') {
      window.location.replace('/announcements');
    }
  }, []);

  const recentActivity = isAuthenticated && activity.length > 0 ? activity : [];

  const showPersonalStats = status !== 'unauthenticated';
  const statCards: Array<{
    label: string;
    value: string;
    helper: ReactNode;
    helperClass?: string;
    icon: ReactNode;
    tone: StatTone;
  }> = showPersonalStats
    ? [
        {
          label: 'Questions Answered',
          value: formatStat(stats?.questionsAnswered),
          helper: (
            <>
              <TrendingUp className="w-3 h-3 mr-1" />
              {stats
                ? `${stats.weekDelta >= 0 ? '+' : ''}${stats.weekDelta}% this week`
                : 'Loading practice history'}
            </>
          ),
          helperClass: stats && stats.weekDelta < 0 ? 'text-red-600' : 'text-green-600',
          icon: <Target className="w-6 h-6" />,
          tone: 'blue',
        },
        {
          label: 'Accuracy Rate',
          value: formatStat(stats?.accuracy, '%'),
          helper: (
            <>
              <Award className="w-3 h-3 mr-1" />
              {stats && stats.accuracy >= 80
                ? 'Great work!'
                : stats && stats.accuracy > 0
                  ? 'Keep practicing'
                  : stats
                    ? 'Start a session'
                    : 'Loading graded attempts'}
            </>
          ),
          icon: <Award className="w-6 h-6" />,
          tone: 'green',
        },
        {
          label: 'Study Streak',
          value: stats ? `${formatStat(stats.studyStreak)} days` : '...',
          helper: (
            <>
              <Zap className="w-3 h-3 mr-1" />
              {stats
                ? stats.studyStreak > 0 ? 'Keep it going!' : 'Study today to start'
                : 'Loading activity days'}
            </>
          ),
          icon: <Star className="w-6 h-6" />,
          tone: 'orange',
        },
        {
          label: 'Hours Studied',
          value: stats ? `${formatStat(stats.hoursStudied)}h` : '...',
          helper: (
            <>
              <Clock className="w-3 h-3 mr-1" />
              {stats
                ? stats.hoursStudied > 0
                  ? `${stats.noteCount} notes - ${stats.bookmarkCount} bookmarks`
                  : 'Log a session'
                : 'Loading study sessions'}
            </>
          ),
          icon: <Clock className="w-6 h-6" />,
          tone: 'purple',
        },
      ]
    : [
        {
          label: 'Question Bank',
          value: formatStat(platformStats?.questions),
          helper: 'Past-paper questions ready',
          icon: <Target className="w-6 h-6" />,
          tone: 'blue',
        },
        {
          label: 'Subjects Covered',
          value: formatStat(platformStats?.subjects),
          helper: 'Syllabuses represented',
          icon: <BookOpen className="w-6 h-6" />,
          tone: 'green',
        },
        {
          label: 'Past Papers',
          value: formatStat(platformStats?.pastPapers),
          helper: 'Question papers indexed',
          icon: <FileText className="w-6 h-6" />,
          tone: 'orange',
        },
        {
          label: 'Learning Resources',
          value: formatStat(platformStats?.resources),
          helper: `${formatStat(platformStats?.mockExams)} mock exams generated`,
          icon: <Library className="w-6 h-6" />,
          tone: 'purple',
        },
      ];

  const dashboardFocus = useMemo(() => {
    if (!isAuthenticated) {
      return {
        title: 'Sign in to save your progress',
        body: 'Use one account for planning, practice, and materials.',
        primaryLabel: 'Sign in',
        primaryHref: '/auth/login',
        shortcuts: [
          { label: 'Practice', icon: Database, action: () => openRoute({ tab: 'practice', practiceMode: 'browse' }) },
          { label: 'Materials', icon: Layers3, action: () => openRoute({ tab: 'materials' }) },
        ],
      };
    }

    const dueReviews = learningOverview?.dueReviews ?? 0;
    const overdueTask = learningOverview?.overdueTasks[0] ?? null;
    const todayTask = learningOverview?.todayTasks[0] ?? null;
    const nextQuestion = learningOverview?.adaptiveQueue[0] ?? null;

    if (dueReviews > 0) {
      return {
        title: 'Review due cards',
        body: `${dueReviews} review item${dueReviews === 1 ? '' : 's'} are waiting.`,
        primaryLabel: 'Open review',
        primaryAction: () => openRoute({ tab: 'study', studyView: 'review' }),
        shortcuts: [
          { label: 'Study', icon: Brain, action: () => openRoute({ tab: 'study', studyView: 'today' }) },
          { label: 'Practice', icon: Database, action: () => openRoute({ tab: 'practice', practiceMode: 'browse' }) },
          { label: 'Materials', icon: Layers3, action: () => openRoute({ tab: 'materials' }) },
          { label: 'Mock exams', icon: ClipboardList, action: () => openRoute({ tab: 'mock-exams' }) },
        ],
      };
    }

    if (overdueTask || todayTask) {
      const task = overdueTask ?? todayTask;
      return {
        title: overdueTask ? 'Finish an overdue task' : 'Continue today\'s plan',
        body: `${task?.title} · ${task?.subject} · ${task?.durationMinutes} min`,
        primaryLabel: 'Open study',
        primaryAction: () => openRoute({ tab: 'study', studyView: 'today' }),
        shortcuts: [
          { label: 'Study', icon: Brain, action: () => openRoute({ tab: 'study', studyView: 'today' }) },
          { label: 'Practice', icon: Database, action: () => openRoute({ tab: 'practice', practiceMode: 'browse' }) },
          { label: 'Materials', icon: Layers3, action: () => openRoute({ tab: 'materials' }) },
          { label: 'Mock exams', icon: ClipboardList, action: () => openRoute({ tab: 'mock-exams' }) },
        ],
      };
    }

    if (nextQuestion) {
      return {
        title: 'Practice your weakest topic',
        body: `${nextQuestion.topic} · ${nextQuestion.subject}`,
        primaryLabel: 'Open question',
        primaryAction: () => openRoute({ tab: 'practice', questionId: nextQuestion.questionId, practiceMode: 'practice' }),
        shortcuts: [
          { label: 'Study', icon: Brain, action: () => openRoute({ tab: 'study', studyView: 'plan' }) },
          { label: 'Practice', icon: Database, action: () => openRoute({ tab: 'practice', practiceMode: 'browse' }) },
          { label: 'Materials', icon: Layers3, action: () => openRoute({ tab: 'materials' }) },
          { label: 'Mock exams', icon: ClipboardList, action: () => openRoute({ tab: 'mock-exams' }) },
        ],
      };
    }

    return {
      title: 'Choose a starting point',
      body: 'Plan, practice, review, or open your materials.',
      primaryLabel: 'Open study',
      primaryAction: () => openRoute({ tab: 'study', studyView: 'today' }),
      shortcuts: [
        { label: 'Study', icon: Brain, action: () => openRoute({ tab: 'study', studyView: 'today' }) },
        { label: 'Practice', icon: Database, action: () => openRoute({ tab: 'practice', practiceMode: 'browse' }) },
        { label: 'Materials', icon: Layers3, action: () => openRoute({ tab: 'materials' }) },
        { label: 'Mock exams', icon: ClipboardList, action: () => openRoute({ tab: 'mock-exams' }) },
      ],
    };
  }, [isAuthenticated, learningOverview, openRoute]);

  // Collapsing is a desktop-only affordance. While the mobile drawer is open
  // it is always shown expanded, so the labels don't stay `sr-only` inside a
  // full-width drawer just because the user collapsed it on a larger screen.
  const sidebarCollapsed = isMainSidebarCollapsed && !isMobileNavOpen;
  const sidebarNavItemClass = (active: boolean) => (
    `w-full flex items-center ${sidebarCollapsed ? 'justify-center px-0' : 'space-x-3 px-4'} py-3 text-sm font-medium rounded-xl transition-all duration-200 ${
      active
        ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white shadow-lg shadow-indigo-500/30'
        : 'text-gray-700 hover:bg-gray-100'
    }`
  );
  const sidebarNavLabelClass = sidebarCollapsed ? 'sr-only' : '';

  return (
    <ScreenContextProvider>
    <TabContextSync activeTab={activeTab} />
    {/* h-dvh, not h-screen: on mobile browsers h-screen ignores the dynamic
        toolbars and the bottom of the app gets clipped. */}
    <div className="relative isolate flex h-dvh text-gray-900 dark:text-gray-100 transition-colors overflow-hidden">
      {/* Background image layer (user-customizable, behind the glass shell) */}
      {visibleBgImage ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={visibleBgImage}
            alt=""
            className="fixed inset-0 w-full h-full object-cover -z-10 pointer-events-none"
            style={{ filter: 'saturate(1.1)' }}
          />
          {/* Dark scrim so text stays legible over busy photos */}
          <div className="fixed inset-0 -z-10 bg-white/30 dark:bg-gray-950/50" />
        </>
      ) : (
        <div className="fixed inset-0 -z-10 bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50/40 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900" />
      )}

      {/* Scrim behind the mobile drawer. Desktop never renders it. */}
      {isMobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-gray-900/50 backdrop-blur-sm lg:hidden"
          onClick={() => setIsMobileNavOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Left Sidebar Navigation — translucent glass.
          Below `lg` this is a fixed off-canvas drawer: as a static 256px
          column it left roughly 119px of usable width on a 375px phone.
          From `lg` up it returns to being an in-flow column that the
          collapse button narrows to 80px. */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col bg-white/60 dark:bg-gray-900/40 backdrop-blur-2xl backdrop-saturate-150 border-r border-white/30 dark:border-white/10 shadow-xl transition-transform duration-300 lg:static lg:max-w-none lg:translate-x-0 lg:transition-all ${
          isMobileNavOpen ? 'translate-x-0' : '-translate-x-full'
        } ${sidebarCollapsed ? 'lg:w-20' : 'lg:w-64'}`}
      >

        {/* Dismiss control for the mobile drawer; the desktop column has no
            overlay to escape from, so it is hidden from `lg` up. */}
        <button
          onClick={() => setIsMobileNavOpen(false)}
          className="absolute right-3 top-3 rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 lg:hidden"
          aria-label="Close navigation"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Logo */}
        <div className={`${sidebarCollapsed ? 'p-4' : 'p-6'} border-b border-white/30 dark:border-white/10`}>
          {/* A button, not a clickable div: as a div it was invisible to
              keyboard and screen-reader users even though it is the app's
              "home" control. */}
          <button
            type="button"
            onClick={() => openRoute({ tab: 'dashboard' })}
            aria-label="YKPao Study — go to dashboard"
            className={`flex w-full items-center ${sidebarCollapsed ? 'justify-center' : 'space-x-3'} cursor-pointer group rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500`}
          >
            <div className="w-10 h-10 bg-gradient-to-br from-green-500 to-emerald-600 rounded-xl flex items-center justify-center shadow-lg shadow-green-500/20 group-hover:shadow-green-500/40 transition-all duration-300 group-hover:scale-105">
              <GraduationCap className="w-6 h-6 text-white" />
            </div>
            <span className={`${sidebarCollapsed ? 'sr-only' : 'text-xl'} font-bold bg-gradient-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent`}>YKPao Study</span>
          </button>
        </div>

        {/* Navigation Links */}
        <nav className={`${sidebarCollapsed ? 'px-2' : 'px-4'} flex-1 space-y-2 overflow-y-auto py-6`}>
          <button
            onClick={() => openRoute({ tab: 'dashboard' })}
            title="Dashboard"
            className={sidebarNavItemClass(activeTab === 'dashboard')}
          >
            <Home className="w-5 h-5" />
            <span className={sidebarNavLabelClass}>Dashboard</span>
          </button>

          <button
            onClick={() => openRoute({ tab: 'study', studyView: 'today' })}
            title="Study"
            className={sidebarNavItemClass(activeTab === 'study')}
          >
            <Brain className="w-5 h-5" />
            <span className={sidebarNavLabelClass}>Study</span>
          </button>

          <button
            onClick={() => openRoute({ tab: 'practice', practiceMode: 'browse' })}
            title="Practice"
            className={sidebarNavItemClass(activeTab === 'practice')}
          >
            <Database className="w-5 h-5" />
            <span className={sidebarNavLabelClass}>Practice</span>
          </button>

          {/* Past papers is its own route rather than a tab, because the PDF
              viewer at /papers/[id] navigates away from the shell anyway. */}
          <Link
            href="/papers"
            title="Past Papers"
            className={sidebarNavItemClass(false)}
            onClick={() => setIsMobileNavOpen(false)}
          >
            <Library className="w-5 h-5" />
            <span className={sidebarNavLabelClass}>Past Papers</span>
          </Link>

          <button
            onClick={() => openRoute({ tab: 'materials' })}
            title="Materials"
            className={sidebarNavItemClass(activeTab === 'materials')}
          >
            <Layers3 className="w-5 h-5" />
            <span className={sidebarNavLabelClass}>Materials</span>
          </button>

          <button
            onClick={() => openRoute({ tab: 'mock-exams' })}
            title="Mock Exams"
            className={sidebarNavItemClass(activeTab === 'mock-exams')}
          >
            <ClipboardList className="w-5 h-5" />
            <span className={sidebarNavLabelClass}>Mock Exams</span>
          </button>

          <button
            onClick={() => openRoute({ tab: 'discussions' })}
            title="Discussion Board"
            className={sidebarNavItemClass(activeTab === 'discussions')}
          >
            <MessagesSquare className="w-5 h-5" />
            <span className={sidebarNavLabelClass}>Discussion Board</span>
          </button>
        </nav>

        {/* User Account Section */}
        <div className={`${sidebarCollapsed ? 'px-2 py-4' : 'p-4'} border-t border-white/30 dark:border-white/10`}>
          {isAuthenticated ? (
            <div className="relative">
              <button
                onClick={() => setIsAccountOpen(!isAccountOpen)}
                title={user?.name ?? 'Account'}
                className={`w-full flex items-center ${sidebarCollapsed ? 'justify-center px-0 py-3' : 'space-x-3 px-3 py-3'} rounded-xl hover:bg-gray-100 transition-all duration-200 focus:outline-none`}
              >
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 flex items-center justify-center text-white font-semibold text-sm shadow-md overflow-hidden">
                  {user?.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={user.image} alt={user.name ?? 'User'} className="w-full h-full object-cover" />
                  ) : (
                    userInitials
                  )}
                </div>
                {!sidebarCollapsed && (
                  <>
                    <div className="flex-1 min-w-0 text-left">
                      <p className="text-sm font-semibold text-gray-800 truncate">{user?.name ?? 'Student'}</p>
                      <p className="text-xs text-gray-500 truncate">{user?.email}</p>
                    </div>
                    <Settings className="w-4 h-4 flex-shrink-0 text-gray-400" />
                  </>
                )}
              </button>

              {isAccountOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setIsAccountOpen(false)} />
                  <div className={`absolute bottom-full mb-2 bg-white border border-gray-200 rounded-2xl shadow-2xl py-2 z-50 ${sidebarCollapsed ? 'left-0 w-72' : 'left-0 right-0'}`}>
                    <div className="px-4 py-3 border-b border-gray-100">
                      <p className="text-sm font-semibold text-gray-800 truncate">{user?.name ?? 'Student Account'}</p>
                      <p className="text-xs text-gray-500 truncate mt-0.5">{user?.email}</p>
                    </div>
                    <div className="py-1">
                      <a
                        href="/account"
                        className="w-full flex items-center space-x-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        <User className="w-4 h-4" />
                        <span>Account Settings</span>
                      </a>
                      <a
                        href="/usage"
                        className="w-full flex items-center space-x-3 px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        <BarChart3 className="w-4 h-4" />
                        <span>Usage & API Credits</span>
                      </a>
                      {(user?.role === 'admin' || user?.role === 'super_admin') && (
                        <a
                          href="/admin"
                          className="w-full flex items-center space-x-3 px-4 py-2.5 text-sm text-indigo-600 hover:bg-indigo-50 transition-colors font-medium"
                        >
                          <ShieldCheck className="w-4 h-4" />
                          <span>Admin Console</span>
                        </a>
                      )}
                    </div>
                    <div className="border-t border-gray-100 mt-1 pt-1">
                      <button
                        onClick={async () => {
                          await signOut({
                            redirect: false,
                            callbackUrl: `${window.location.origin}/`,
                          });
                          window.location.assign('/');
                        }}
                        className="w-full flex items-center space-x-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors font-medium"
                      >
                        <LogOut className="w-4 h-4" />
                        <span>Log out</span>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Link
                href="/auth/login"
                title="Sign In"
                className={`w-full flex items-center ${sidebarCollapsed ? 'justify-center px-0' : 'justify-center space-x-2 px-4'} py-3 text-sm font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-500 rounded-xl shadow-lg shadow-indigo-500/30 hover:shadow-indigo-500/40 transition-all duration-200`}
              >
                <LogIn className="w-4 h-4" />
                <span className={sidebarCollapsed ? 'sr-only' : ''}>Sign In</span>
              </Link>
              <Link
                href="/auth/signup"
                title="Create Account"
                className={`w-full flex items-center ${sidebarCollapsed ? 'justify-center px-0' : 'justify-center space-x-2 px-4'} py-3 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-xl hover:bg-gray-50 transition-all duration-200`}
              >
                <User className="w-4 h-4" />
                <span className={sidebarCollapsed ? 'sr-only' : ''}>Create Account</span>
              </Link>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Top Bar with Notifications — glass */}
        <header className="flex items-center justify-between px-6 py-4 bg-white/50 dark:bg-gray-900/40 backdrop-blur-2xl backdrop-saturate-150 border-b border-white/30 dark:border-white/10 shadow-sm">
          <div className="flex items-center space-x-4">
            {/* Mobile: open the navigation drawer. */}
            <button
              onClick={() => setIsMobileNavOpen(true)}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors lg:hidden"
              aria-label="Open navigation"
              aria-expanded={isMobileNavOpen}
            >
              <Menu className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            </button>

            {/* Desktop: collapse the sidebar to icons. */}
            <button
              onClick={() => setIsMainSidebarCollapsed(!isMainSidebarCollapsed)}
              className="hidden p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors lg:block"
              aria-label={isMainSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={isMainSidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            >
              {isMainSidebarCollapsed ? (
                <PanelLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
              ) : (
                <PanelLeftClose className="w-5 h-5 text-gray-600 dark:text-gray-400" />
              )}
            </button>

            <div>
              <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                {activeTab === 'dashboard' && 'Dashboard'}
                {activeTab === 'study' && 'Study'}
                {activeTab === 'practice' && 'Practice'}
                {activeTab === 'materials' && 'Materials'}
                {activeTab === 'mock-exams' && 'Mock Exams'}
                {activeTab === 'discussions' && 'Discussion Board'}
              </h1>
            </div>
          </div>
          <div className="flex items-center space-x-4">
            <button
              onClick={() => setIsAIAssistantOpen(!isAIAssistantOpen)}
              className={`p-2.5 rounded-xl transition-all duration-200 ${
                isAIAssistantOpen
                  ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white shadow-lg shadow-green-500/30'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
              title="AI Tutor"
            >
              <Sparkles className="w-5 h-5" />
            </button>
            <ThemeToggle />
            <NotificationBell />
          </div>
        </header>

        {/* Main Workspace */}
        <div className="flex-1 overflow-hidden">

        {/* VIEW 0: Dashboard */}
        {activeTab === 'dashboard' && (
          <main className="h-full overflow-y-auto p-6 md:p-8">
            <div className="mx-auto max-w-7xl space-y-6">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Welcome back, {user?.name?.split(' ')[0] ?? 'Student'}!</h1>
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">One next step, then the next.</p>
                </div>
                <div className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
                  <Calendar className="h-4 w-4" />
                  Today
                </div>
              </div>

              <AnnouncementBanner />

              {stats?.nudges && stats.nudges.length > 0 && (
                <section className="flex flex-wrap gap-2" aria-label="Study updates">
                  {stats.nudges.map((nudge) => (
                    <button key={nudge.type} onClick={() => nudge.action === 'review' ? openRoute({ tab: 'study', studyView: 'review' }) : nudge.action === 'plan' ? openRoute({ tab: 'study', studyView: 'plan' }) : openRoute({ tab: 'practice', practiceMode: 'browse' })} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-700 hover:border-emerald-300 hover:bg-emerald-50 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300 dark:hover:border-emerald-700 dark:hover:bg-emerald-950/30">
                      {nudge.type === 'reviews' ? <Brain className="h-4 w-4 text-emerald-600" /> : nudge.type === 'stalled' ? <Calendar className="h-4 w-4 text-amber-600" /> : <Database className="h-4 w-4 text-blue-600" />}
                      {nudge.label}
                      <ArrowRight className="h-3.5 w-3.5 text-gray-400" />
                    </button>
                  ))}
                </section>
              )}

              <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900 md:p-6">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                  <div className="max-w-2xl">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-400">Next step</p>
                    <h2 className="mt-2 text-2xl font-bold text-gray-900 dark:text-gray-100">{dashboardFocus.title}</h2>
                    <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{dashboardFocus.body}</p>
                    {isAuthenticated && learningOverview && (
                      <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-medium text-gray-500 dark:text-gray-400">
                        <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 dark:border-gray-700 dark:bg-gray-800">
                          {learningOverview.summary.tasksDue} tasks due
                        </span>
                        <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 dark:border-gray-700 dark:bg-gray-800">
                          {learningOverview.dueReviews} reviews due
                        </span>
                        <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 dark:border-gray-700 dark:bg-gray-800">
                          {learningOverview.summary.topicsMastered} mastered
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {dashboardFocus.primaryHref ? (
                      <Link
                        href={dashboardFocus.primaryHref}
                        className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700"
                      >
                        {dashboardFocus.primaryLabel}
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    ) : (
                      <button
                        onClick={dashboardFocus.primaryAction}
                        className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700"
                      >
                        {dashboardFocus.primaryLabel}
                        <ArrowRight className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {dashboardFocus.shortcuts.map((shortcut) => {
                    const Icon = shortcut.icon;
                    return (
                      <button
                        key={shortcut.label}
                        onClick={shortcut.action}
                        className="inline-flex items-center justify-between gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-left text-sm font-semibold text-gray-700 transition-colors hover:border-emerald-300 hover:bg-emerald-50 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-300 dark:hover:border-emerald-500/50 dark:hover:bg-emerald-950/30"
                      >
                        <span className="inline-flex items-center gap-2">
                          <Icon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                          {shortcut.label}
                        </span>
                        <ArrowRight className="h-4 w-4 text-gray-400" />
                      </button>
                    );
                  })}
                </div>
              </section>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {statCards.map((card) => {
                  const tone = statToneStyles[card.tone];

                  return (
                    <div
                      key={card.label}
                      className="floating-panel rounded-2xl border border-gray-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md dark:border-gray-800 dark:bg-gray-900"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-600 dark:text-gray-400">{card.label}</p>
                          <p className="mt-2 text-3xl font-bold text-gray-900 dark:text-gray-100">{card.value}</p>
                          <p className={`mt-2 flex items-center text-xs ${card.helperClass ?? tone.helper}`}>
                            {card.helper}
                          </p>
                        </div>
                        <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${tone.icon}`}>
                          {card.icon}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.9fr)]">
                <section className="floating-panel rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
                  <div className="mb-5 flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Recent activity</h2>
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Keep the streak moving from here.</p>
                    </div>
                    <button
                      onClick={() => openRoute({ tab: 'practice', practiceMode: 'browse' })}
                      className="inline-flex items-center gap-2 text-sm font-medium text-emerald-700 hover:text-emerald-800 dark:text-emerald-400"
                    >
                      Practice
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="space-y-3">
                    {recentActivity.length === 0 ? (
                      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-200 bg-gray-50 py-12 text-gray-500 dark:border-gray-800 dark:bg-gray-950/40">
                        <BookMarked className="h-10 w-10 opacity-40" />
                        <p className="mt-3 text-sm font-medium">No activity yet</p>
                        <p className="mt-1 text-xs">Answer a few questions to fill this in.</p>
                      </div>
                    ) : (
                      recentActivity.map((a, idx) => (
                        <button
                          key={idx}
                          onClick={() => openRoute({ tab: 'practice', practiceMode: 'browse' })}
                          className="flex w-full items-center justify-between gap-4 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-left transition-colors hover:border-emerald-300 hover:bg-emerald-50 dark:border-gray-800 dark:bg-gray-950 dark:hover:border-emerald-500/50 dark:hover:bg-emerald-950/30"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300">
                              <BookMarked className="h-5 w-5" />
                            </div>
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-gray-900 dark:text-gray-100">{a.subject}</p>
                              <p className="truncate text-sm text-gray-600 dark:text-gray-400">{a.questions} question{a.questions === 1 ? '' : 's'} · {a.accuracy}% accuracy</p>
                            </div>
                          </div>
                          <span className="text-xs text-gray-500 dark:text-gray-400">{a.timeLabel}</span>
                        </button>
                      ))
                    )}
                  </div>
                </section>

                <div className="space-y-6">
                  <DailyChallenge />
                  <TrendingNotes />
                  <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
                    <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Study shortcuts</h2>
                    <div className="mt-4 grid grid-cols-2 gap-2">
                      {[
                        { label: 'Study', icon: Brain, action: () => openRoute({ tab: 'study', studyView: 'today' }) },
                        { label: 'Practice', icon: Database, action: () => openRoute({ tab: 'practice', practiceMode: 'browse' }) },
                        { label: 'Materials', icon: Layers3, action: () => openRoute({ tab: 'materials' }) },
                        { label: 'Mock exams', icon: ClipboardList, action: () => openRoute({ tab: 'mock-exams' }) },
                      ].map((item) => {
                        const Icon = item.icon;
                        return (
                          <button
                            key={item.label}
                            onClick={item.action}
                            className="inline-flex items-center justify-between gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 text-left text-sm font-semibold text-gray-700 transition-colors hover:border-emerald-300 hover:bg-emerald-50 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-300 dark:hover:border-emerald-500/50 dark:hover:bg-emerald-950/30"
                          >
                            <span className="inline-flex items-center gap-2">
                              <Icon className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                              {item.label}
                            </span>
                            <ArrowRight className="h-4 w-4 text-gray-400" />
                          </button>
                        );
                      })}
                    </div>
                  </section>
                </div>
              </div>
            </div>
          </main>
        )}

        {/* VIEW 1: Study */}
        {activeTab === 'study' && (
          <StudyCoach
            initialView={studyStartView}
            onOpenQuestion={(questionId) => {
              openRoute({ tab: 'practice', questionId, practiceMode: 'practice' });
            }}
            onOpenMockExams={() => openRoute({ tab: 'mock-exams' })}
          />
        )}

        {/* VIEW 2: Practice */}
        {activeTab === 'practice' && (
          <QuestionsDatabase
            initialQuestionId={pendingQuestionId}
            initialMode={practiceStartMode}
            onQuestionOpened={() => setPendingQuestionId(null)}
          />
        )}

        {/* VIEW 3: Materials */}
        {activeTab === 'materials' && (
          <MaterialsHub />
        )}

        {/* VIEW 4: Mock Exams */}
        {activeTab === 'mock-exams' && (
          <MockExams />
        )}

        {/* VIEW 5: Discussion Board */}
        {activeTab === 'discussions' && (
          <DiscussionBoard
            pendingThreadId={pendingThreadId}
            onThreadOpened={() => setPendingThreadId(null)}
          />
        )}

        </div>
      </div>

      {/* Floating AI Assistant */}
      <FloatingAIAssistant
        isOpen={isAIAssistantOpen}
        onClose={() => setIsAIAssistantOpen(false)}
      />

      {/* First-login onboarding wizard */}
      {showOnboarding && (
        <OnboardingWizard
          onComplete={() => {
            setShowOnboarding(false);
            // Re-fetch dashboard now that the user has enrolled in courses.
            setRefreshTick((n) => n + 1);
          }}
        />
      )}
    </div>
    </ScreenContextProvider>
  );
}

// Tiny invisible component that syncs the active tab into ScreenContext.
// Must live inside <ScreenContextProvider> to use the hook.
function TabContextSync({ activeTab }: { activeTab: MainTab }) {
  const screenCtx = useScreenContext();
  useEffect(() => {
    const labels: Record<string, string> = {
      dashboard: 'Dashboard — guided study overview',
      study: 'Study — plan, review, and mastery',
      practice: 'Practice — question bank and worked answers',
      materials: 'Materials — notebook and library',
      'mock-exams': 'Mock Exams',
      discussions: 'Discussion Board',
    };
    screenCtx.update({ tab: activeTab, description: labels[activeTab] ?? activeTab });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);
  return null;
}
