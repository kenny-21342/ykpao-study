"use client";

import { useState, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { useSession } from 'next-auth/react';
import toast from 'react-hot-toast';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import ThemeToggle from './ThemeToggle';
import {
  parseRoute,
  resolveRoute,
  routeToQuery,
  type MainTab,
  type PracticeMode,
  type RoutedTab,
  type StudyCoachView,
} from './routing';
import AppSidebar, { SidebarScrim, useSidebarChrome } from './AppSidebar';
import FloatingAIAssistant from './FloatingAIAssistant';
import OnboardingWizard from './OnboardingWizard';
import QuestionsDatabase from './QuestionsDatabase';
import BankPractice from './BankPractice';
import MockExams from './MockExams';
import { isFeaturePreview } from '@/lib/feature-readiness';
import DiscussionBoard from './DiscussionBoard';
import NotificationBell from './NotificationBell';
import StudyCoach from './StudyCoach';
import MaterialsHub from './MaterialsHub';
import DailyChallenge from './DailyChallenge';
import CourseShortcuts from '@/app/components/CourseShortcuts';
import AnnouncementBanner from './AnnouncementBanner';
import AiKeyPrompt from './AiKeyPrompt';
import { StatRow, StatTile } from './ui';
import { ScreenContextProvider, useScreenContext } from './ScreenContext';
import { Database, Sparkles, BookMarked, PanelLeftClose, PanelLeft, ClipboardList, Library, Brain, ArrowRight, Layers3, Menu } from 'lucide-react';

type DashboardStats = {
  questionsAnswered: number;
  accuracy: number;
  studyStreak: number;
  hoursStudied: number;
  noteCount: number;
  thisWeek: number;
  lastWeek: number;
  weekDelta: number;
  nudges: Array<{ type: 'reviews' | 'stalled' | 'corpus'; count: number; label: string; action: 'review' | 'plan' | 'practice' }>;
};

type ActivityItem = {
  subject: string;
  questions: number;
  /** null when nothing in the group is marked — written answers with no key. */
  accuracy: number | null;
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

export default function SmartEduPlatform() {
  const { data: session, status } = useSession();
  const [activeTab, setActiveTab] = useState<MainTab>('dashboard');
  const [pendingQuestionId, setPendingQuestionId] = useState<number | null>(null);
  // Separate from `pendingQuestionId`: that one is a legacy text-bank id and
  // routes to QuestionsDatabase. Bank ids are a different sequence entirely.
  const [pendingBankQuestionId, setPendingBankQuestionId] = useState<number | null>(null);
  // The notebook page a link asked for, handed to Materials once and cleared.
  const [pendingPageId, setPendingPageId] = useState<string | null>(null);
  const [studyStartView, setStudyStartView] = useState<StudyCoachView>('today');
  const [practiceStartMode, setPracticeStartMode] = useState<PracticeMode>('browse');
  const [isAIAssistantOpen, setIsAIAssistantOpen] = useState(false);
  const [learningOverview, setLearningOverview] = useState<LearningOverview | null>(null);

  // Below `lg` the sidebar is an off-canvas drawer rather than a column, so it
  // needs its own open/closed state independent of the desktop collapse.
  // Declared before `openRoute`, which closes the drawer on navigation.
  //
  // Shared with /papers through `useSidebarChrome`, so a student who collapses
  // the sidebar here still finds it collapsed after opening Past Papers.
  const {
    collapsed: sidebarCollapsed,
    collapsedPreference: isMainSidebarCollapsed,
    toggleCollapsed,
    mobileOpen: isMobileNavOpen,
    openMobile,
    closeMobile,
  } = useSidebarChrome();

  /**
   * Apply a destination to state without touching history. Used on mount,
   * where the URL is already the destination, and on popstate, where pushing
   * again would trap Back in a loop.
   */
  const applyRoute = useCallback((route: RoutedTab) => {
    if (route.tab === 'study') {
      setStudyStartView(route.studyView ?? 'today');
      setPendingQuestionId(null);
    } else if (route.tab === 'practice') {
      setPracticeStartMode(route.practiceMode ?? (route.questionId ? 'practice' : 'browse'));
      setPendingQuestionId(route.questionId ?? null);
      // Only one of the two can be pending: the practice tab renders
      // QuestionsDatabase when a legacy id is set and BankPractice otherwise,
      // so leaving a stale legacy id here would swallow the bank route.
      if (route.bankQuestionId) setPendingBankQuestionId(route.bankQuestionId);
    } else if (route.tab === 'materials') {
      setPendingQuestionId(null);
      setPendingPageId(route.pageId ?? null);
    } else {
      setPendingQuestionId(null);
    }
    setActiveTab(route.tab);
    // Navigating from the drawer should dismiss it, or the destination stays
    // hidden behind the overlay on a phone.
    closeMobile();
  }, [closeMobile]);

  /**
   * The navigating version, used by every control a student can click. The
   * tabs are still tab state rather than routes, but each move now leaves a
   * history entry, so Back returns to the previous tab instead of leaving the
   * site, and the address bar names what is actually on screen.
   *
   * Raw history.pushState rather than useRouter: `app/page.tsx` is a server
   * component, so useSearchParams would force a Suspense boundary around every
   * tab click, and router.push would re-run the server render for a change
   * that is purely client state.
   */
  const openRoute = useCallback((route: RoutedTab) => {
    applyRoute(route);
    const query = routeToQuery(route);
    const next = `${window.location.pathname}${query ? `?${query}` : ''}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.pushState(null, '', next);
    }
  }, [applyRoute]);

  useEffect(() => {
    const onPopState = () => {
      const route = parseRoute(window.location.search);
      applyRoute(route ?? { tab: 'dashboard' });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyRoute]);

  // While the question bank is a preview, the dashboard stops *recommending*
  // it: every "here is something to go and do" control points at Past Papers,
  // which is complete, instead. The Practice entrance in the sidebar stays —
  // this changes what the dashboard suggests, not what is reachable.
  const bankIsPreview = isFeaturePreview('question-bank');
  const router = useRouter();
  const openPracticeOrPapers = useCallback(() => {
    if (bankIsPreview) {
      closeMobile();
      router.push('/papers');
      return;
    }
    openRoute({ tab: 'practice', practiceMode: 'browse' });
  }, [bankIsPreview, router, openRoute, closeMobile]);
  // Memoised because it is a dependency of the dashboard-focus memo below; a
  // fresh object each render would recompute that on every keystroke.
  const practiceShortcut = useMemo(
    () => (bankIsPreview
      ? { label: 'Past Papers', icon: Library, action: openPracticeOrPapers }
      : { label: 'Practice', icon: Database, action: openPracticeOrPapers }),
    [bankIsPreview, openPracticeOrPapers],
  );

  // Escape closes the mobile navigation drawer.
  useEffect(() => {
    if (!isMobileNavOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMobile();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isMobileNavOpen, closeMobile]);

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
  /**
   * NextAuth reports 'loading' until it has resolved the session, and treating
   * that as signed-out is how a signed-in student is shown "Sign in to save
   * your progress", called "Student", and offered Sign In / Create Account for
   * the first seconds of every load. It is what made a working Google login
   * look broken. Anything that says "you are signed out" has to wait for this.
   */
  const isSessionLoading = status === 'loading';
  // User-customizable background image (fetched from /api/account via session).
  const [bgImage, setBgImage] = useState<string | null>(null);

  // Onboarding wizard — show once for users who haven't completed it.
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Bumped to force a dashboard refresh (e.g. after onboarding completes).
  const [refreshTick, setRefreshTick] = useState(0);

  // This shell only ever renders for a signed-in user -- `app/page.tsx` decides
  // that on the server and hands a guest the landing page instead -- so the
  // public platform totals it used to fetch have moved there, where they are
  // server-rendered and therefore crawlable.
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);

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
      // `/api/dashboard` failing used to be indistinguishable from a brand-new
      // account: the tiles stayed on their zero defaults and the activity list
      // stayed empty, so a student with months of work was quietly told they
      // had none. The other two degrade honestly on their own -- an absent
      // overview hides its panel rather than emptying it, and an absent
      // onboarding answer simply does not raise the wizard -- but this one has
      // a zero state that looks like real data, so it has to say so.
      setStatsError(data ? null : 'Your progress could not be loaded just now.');
      if (data) {
        setStats({
          questionsAnswered: data.questionsAnswered ?? 0,
          accuracy: data.accuracy ?? 0,
          studyStreak: data.studyStreak ?? 0,
          hoursStudied: data.hoursStudied ?? 0,
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
    // The heatmap's "practise these" button dispatched this and nothing had
    // ever listened, because the component was imported by no file at all.
    const onOpenWeaknessPractice = (e: Event) => {
      const questionId = (e as CustomEvent).detail?.questionId;
      openRoute({
        tab: 'practice',
        practiceMode: 'practice',
        questionId: typeof questionId === 'number' ? questionId : null,
      });
    };
    window.addEventListener('open-discussions', onOpenDiscussions as EventListener);
    window.addEventListener('open-notes', onOpenNotes as EventListener);
    window.addEventListener('open-weakness-practice', onOpenWeaknessPractice as EventListener);
    return () => {
      window.removeEventListener('open-discussions', onOpenDiscussions as EventListener);
      window.removeEventListener('open-notes', onOpenNotes as EventListener);
      window.removeEventListener('open-weakness-practice', onOpenWeaknessPractice as EventListener);
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

  // Read URL parameters synchronously on mount rather than inside a deferred
  // timer. The old `setTimeout(…, 0)` ran after the first paint, so a sidebar
  // click that landed before the timer fired was immediately overwritten —
  // making the first click after page load appear to be swallowed.
  //
  // useLayoutEffect, not useEffect: it still runs after hydration (so there is
  // no server/client mismatch) but flushes in the same task as the commit,
  // before the browser can deliver any click, keeping that window at zero.
  //
  // The setState-in-effect rule is suppressed on purpose: this is a one-time
  // hydration initialization from an external system (the URL), and it cannot
  // move into a state initializer without breaking server-rendered markup.
  useLayoutEffect(() => {
    const params = new URLSearchParams(window.location.search);

    // app/admin/layout.tsx redirects here with
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

    // applyRoute, not openRoute: the URL already *is* this destination, so
    // pushing it again would put a duplicate entry in front of wherever the
    // student came from.
    const route = parseRoute(window.location.search);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time hydration init, see block comment above
    if (route) applyRoute(route);
  }, [applyRoute]);

  useEffect(() => {
    if (window.location.pathname === '/' && window.location.hash === '#announcements') {
      window.location.replace('/announcements');
    }
  }, []);

  const recentActivity = isAuthenticated && activity.length > 0 ? activity : [];

  /**
   * Four figures for the header row. They were four bordered cards, each with
   * its own accent colour and a tinted icon square -- four colours for four
   * things that mean the same kind of thing, and four of the eleven-odd boxes
   * a student met on first load. StatTile carries no border and no icon.
   */
  const statCards: Array<{
    label: string;
    value: string;
    hint?: string;
    delta?: { value: string; direction: 'up' | 'down' | 'flat' };
  }> = [
    {
      label: 'Answered',
      value: formatStat(stats?.questionsAnswered),
      delta: stats
        ? {
            value: `${stats.weekDelta >= 0 ? '+' : ''}${stats.weekDelta}% this week`,
            direction: stats.weekDelta > 0 ? 'up' : stats.weekDelta < 0 ? 'down' : 'flat',
          }
        : undefined,
      hint: stats ? undefined : 'Loading practice history',
    },
    {
      label: 'Accuracy',
      value: formatStat(stats?.accuracy, '%'),
      hint: stats
        ? stats.accuracy >= 80
          ? 'Great work'
          : stats.accuracy > 0
            ? 'Keep practicing'
            : 'Start a session'
        : 'Loading graded attempts',
    },
    {
      label: 'Streak',
      value: stats ? `${formatStat(stats.studyStreak)} days` : '...',
      hint: stats
        ? stats.studyStreak > 0 ? 'Keep it going' : 'Study today to start'
        : 'Loading activity days',
    },
    {
      label: 'Hours studied',
      value: stats ? `${formatStat(stats.hoursStudied)}h` : '...',
      hint: stats
        ? stats.hoursStudied > 0
          ? `${stats.noteCount} note${stats.noteCount === 1 ? '' : 's'} written`
          : 'Log a session'
        : 'Loading study sessions',
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
          practiceShortcut,
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
          practiceShortcut,
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
          practiceShortcut,
          { label: 'Materials', icon: Layers3, action: () => openRoute({ tab: 'materials' }) },
          { label: 'Mock exams', icon: ClipboardList, action: () => openRoute({ tab: 'mock-exams' }) },
        ],
      };
    }

    // Skipped while the bank is a preview: making a half-extracted question the
    // single headline next step is the strongest recommendation the dashboard
    // makes, and the one least worth making right now.
    if (nextQuestion && !bankIsPreview) {
      return {
        title: 'Practice your weakest topic',
        body: `${nextQuestion.topic} · ${nextQuestion.subject}`,
        primaryLabel: 'Open question',
        primaryAction: () => openRoute({ tab: 'practice', questionId: nextQuestion.questionId, practiceMode: 'practice' }),
        shortcuts: [
          { label: 'Study', icon: Brain, action: () => openRoute({ tab: 'study', studyView: 'plan' }) },
          practiceShortcut,
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
        practiceShortcut,
        { label: 'Materials', icon: Layers3, action: () => openRoute({ tab: 'materials' }) },
        { label: 'Mock exams', icon: ClipboardList, action: () => openRoute({ tab: 'mock-exams' }) },
      ],
    };
  }, [isAuthenticated, learningOverview, openRoute, practiceShortcut, bankIsPreview]);

  // Collapsing is a desktop-only affordance. While the mobile drawer is open
  // it is always shown expanded, so the labels don't stay `sr-only` inside a
  // full-width drawer just because the user collapsed it on a larger screen.

  return (
    <ScreenContextProvider>
    <TabContextSync activeTab={activeTab} />
    {/* h-dvh, not h-screen: on mobile browsers h-screen ignores the dynamic
        toolbars and the bottom of the app gets clipped. */}
    <div className="relative isolate flex h-dvh text-primary transition-colors overflow-hidden">
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
        <div className="fixed inset-0 -z-10 bg-canvas" />
      )}

      <SidebarScrim open={isMobileNavOpen} onClose={() => closeMobile()} />

      <AppSidebar
        active={activeTab}
        collapsed={sidebarCollapsed}
        mobileOpen={isMobileNavOpen}
        onCloseMobile={() => closeMobile()}
        onNavigate={(tab) => openRoute({ tab })}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col overflow-hidden">

        {/* Top Bar with Notifications — glass */}
        <header className="flex items-center justify-between px-6 py-4 bg-white/50 dark:bg-gray-900/40 backdrop-blur-2xl backdrop-saturate-150 border-b border-white/30 dark:border-white/10">
          <div className="flex items-center space-x-4">
            {/* Mobile: open the navigation drawer. */}
            <button
              onClick={() => openMobile()}
              className="p-2 hover:bg-surface-hover rounded-md transition-colors lg:hidden"
              aria-label="Open navigation"
              aria-expanded={isMobileNavOpen}
            >
              <Menu className="w-5 h-5 text-secondary" />
            </button>

            {/* Desktop: collapse the sidebar to icons. */}
            <button
              onClick={toggleCollapsed}
              className="hidden p-2 hover:bg-surface-hover rounded-md transition-colors lg:block"
              aria-label={isMainSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              title={isMainSidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
            >
              {isMainSidebarCollapsed ? (
                <PanelLeft className="w-5 h-5 text-secondary" />
              ) : (
                <PanelLeftClose className="w-5 h-5 text-secondary" />
              )}
            </button>

            <div>
              <h1 className="text-xl font-bold text-primary">
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
              className={`p-2.5 rounded-lg transition-all duration-200 ${
                isAIAssistantOpen
                  ? 'bg-accent text-white'
                  : 'text-secondary hover:bg-surface-hover'
              }`}
              title="AI Tutor" aria-label="AI Tutor"
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
                  {/* h2, not h1: the shell header already titles this view
                      "Dashboard". Bigger than the h1 visually, one level below
                      it semantically, which is the correct way round. */}
                  <h2 className="text-3xl font-bold text-primary">
                    {isSessionLoading
                      ? 'Welcome back!'
                      : `Welcome back, ${user?.name?.split(' ')[0] ?? 'Student'}!`}
                  </h2>
                  <p className="mt-1 text-sm text-secondary">One next step, then the next.</p>
                </div>
              </div>

              {/* The figures, borderless, in the header rather than as four
                  separate cards below it. */}
              <StatRow>
                {statCards.map((card) => (
                  <StatTile
                    key={card.label}
                    label={card.label}
                    value={card.value}
                    hint={card.hint}
                    delta={card.delta}
                  />
                ))}
              </StatRow>

              {/* One notice slot. These were three stacked banners plus a
                  pill row -- an announcement, a stats-failure warning and the
                  AI-key card could all be on screen at once, above the thing
                  the student came to do. Highest priority wins; the others
                  wait. The stats error goes first because it says the figures
                  directly above it are wrong. */}
              {statsError ? (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning-border bg-warning-subtle px-4 py-3 text-sm text-warning">
                  <span>{statsError} The figures above are not your real totals.</span>
                  <button
                    type="button"
                    onClick={() => setRefreshTick((n) => n + 1)}
                    className="font-semibold underline underline-offset-2"
                  >
                    Try again
                  </button>
                </div>
              ) : (
                <>
                  <AnnouncementBanner />
                  <AiKeyPrompt />
                </>
              )}

              <section className="rounded-lg border border-line bg-surface p-5 md:p-6">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                  <div className="max-w-2xl">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Next step</p>
                    <h2 className="mt-2 text-2xl font-bold text-primary">
                      {isSessionLoading ? 'Getting your dashboard ready…' : dashboardFocus.title}
                    </h2>
                    <p className="mt-2 text-sm text-secondary">
                      {isSessionLoading ? 'One moment.' : dashboardFocus.body}
                    </p>
                    {isAuthenticated && learningOverview && (
                      <div className="mt-4 flex flex-wrap gap-2 text-[11px] font-medium text-muted">
                        <span className="rounded-full border border-line bg-surface-raised px-2.5 py-1">
                          {learningOverview.summary.tasksDue} tasks due
                        </span>
                        <span className="rounded-full border border-line bg-surface-raised px-2.5 py-1">
                          {learningOverview.dueReviews} reviews due
                        </span>
                        <span className="rounded-full border border-line bg-surface-raised px-2.5 py-1">
                          {learningOverview.summary.topicsMastered} mastered
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {isSessionLoading ? null : dashboardFocus.primaryHref ? (
                      <Link
                        href={dashboardFocus.primaryHref}
                        className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
                      >
                        {dashboardFocus.primaryLabel}
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    ) : (
                      <button
                        onClick={dashboardFocus.primaryAction}
                        className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
                      >
                        {dashboardFocus.primaryLabel}
                        <ArrowRight className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {(isSessionLoading ? [] : dashboardFocus.shortcuts).map((shortcut) => {
                    const Icon = shortcut.icon;
                    return (
                      <button
                        key={shortcut.label}
                        onClick={shortcut.action}
                        className="inline-flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-raised px-4 py-3 text-left text-sm font-semibold text-secondary transition-colors hover:border-accent-border hover:bg-accent-subtle"
                      >
                        <span className="inline-flex items-center gap-2">
                          <Icon className="h-4 w-4 text-accent-text" />
                          {shortcut.label}
                        </span>
                        <ArrowRight className="h-4 w-4 text-muted" />
                      </button>
                    );
                  })}
                </div>
                {stats?.nudges && stats.nudges.length > 0 && (
                  <div
                    className="mt-4 flex flex-wrap gap-2 border-t border-subtle pt-4"
                    aria-label="Study updates"
                  >
                    {stats.nudges.map((nudge) => (
                      <button
                        key={nudge.type}
                        onClick={() =>
                          nudge.action === 'review'
                            ? openRoute({ tab: 'study', studyView: 'review' })
                            : nudge.action === 'plan'
                              ? openRoute({ tab: 'study', studyView: 'plan' })
                              : openPracticeOrPapers()
                        }
                        className="inline-flex min-h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-xs font-semibold text-secondary transition-colors hover:border-accent-border hover:bg-accent-subtle"
                      >
                        {nudge.label}
                        <ArrowRight className="h-3.5 w-3.5 text-muted" />
                      </button>
                    ))}
                  </div>
                )}
              </section>

              {isAuthenticated && (
                <CourseShortcuts
                  onOpenPractice={openPracticeOrPapers}
                  onOpenMockExams={() => openRoute({ tab: 'mock-exams' })}
                />
              )}

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.9fr)]">
                <section className="rounded-lg border border-line bg-surface p-6">
                  <div className="mb-5 flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-bold text-primary">Recent activity</h2>
                      <p className="mt-1 text-xs text-muted">Keep the streak moving from here.</p>
                    </div>
                    <button
                      onClick={openPracticeOrPapers}
                      className="inline-flex items-center gap-2 text-sm font-medium text-accent-text hover:text-accent-text"
                    >
                      {practiceShortcut.label}
                      <ArrowRight className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="space-y-3">
                    {recentActivity.length === 0 ? (
                      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line bg-surface-raised py-12 text-muted">
                        <BookMarked className="h-10 w-10 opacity-40" />
                        <p className="mt-3 text-sm font-medium">No activity yet</p>
                        <p className="mt-1 text-xs">{bankIsPreview ? 'Open a past paper to get started.' : 'Answer a few questions to fill this in.'}</p>
                      </div>
                    ) : (
                      recentActivity.map((a, idx) => (
                        <button
                          key={idx}
                          onClick={() => openRoute({ tab: 'practice', practiceMode: 'browse' })}
                          className="flex w-full items-center justify-between gap-4 rounded-lg border border-line bg-surface-raised px-4 py-3 text-left transition-colors hover:border-accent-border hover:bg-accent-subtle"
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-raised text-secondary">
                              <BookMarked className="h-5 w-5" />
                            </div>
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-primary">{a.subject}</p>
                              <p className="truncate text-sm text-secondary">{a.questions} question{a.questions === 1 ? '' : 's'}{a.accuracy === null ? ' · not marked yet' : ` · ${a.accuracy}% accuracy`}</p>
                            </div>
                          </div>
                          <span className="text-xs text-muted">{a.timeLabel}</span>
                        </button>
                      ))
                    )}
                  </div>
                </section>

                <div className="space-y-6">
                  <DailyChallenge />
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
            onOpenBankQuestion={(bankQuestionId) => {
              openRoute({ tab: 'practice', bankQuestionId, practiceMode: 'practice' });
            }}
            onOpenMockExams={() => openRoute({ tab: 'mock-exams' })}
          />
        )}

        {/* VIEW 2: Practice
          *
          * Browsing goes to the crop-first bank: 67,873 published questions
          * shown as the page they were printed on, against 5,133 transcribed
          * ones. A crop is also the faithful artefact — a transcription drops
          * the diagrams, tables and notation a past paper is largely made of.
          *
          * A deep link still opens the old browser, because the id in it
          * belongs to the text bank and means nothing to the crop bank. The
          * two are the same corpus but not the same rows, so a link cannot be
          * translated by pointing it at a different table. */}
        {activeTab === 'practice' && (
          pendingQuestionId ? (
            <QuestionsDatabase
              initialQuestionId={pendingQuestionId}
              initialMode={practiceStartMode}
              onQuestionOpened={() => setPendingQuestionId(null)}
            />
          ) : (
            <BankPractice
              initialQuestionId={pendingBankQuestionId}
              onQuestionOpened={() => setPendingBankQuestionId(null)}
            />
          )
        )}

        {/* VIEW 3: Materials */}
        {activeTab === 'materials' && (
          <MaterialsHub
            initialPageId={pendingPageId}
            onPageOpened={(pageId) => {
              setPendingPageId(pageId);
              // Keep the address bar naming the page that is actually open, so
              // copying the URL shares the page rather than the workspace.
              openRoute({ tab: 'materials', pageId });
            }}
          />
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

// The "Preview" chip on a sidebar entry whose feature is not finished. Hidden
// when the sidebar is collapsed, where there is no room for it and the title
// attribute is the only affordance anyway.
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
