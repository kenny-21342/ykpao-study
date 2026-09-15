'use client';

/**
 * The app's left-hand navigation, as a component both the shell and the
 * standalone routes can render.
 *
 * It used to live inline in `app/page.tsx`. That file is the whole app shell,
 * so every route outside it -- `/papers` and `/papers/[id]`, the launch
 * surface -- rendered with no navigation at all: a student who opened Past
 * Papers could reach the browser Back button and nothing else. The pre-launch
 * sweep on 30 Aug walked curriculum → subject → year → series → paper without
 * ever passing a way home.
 *
 * The tabs stay tab state rather than becoming routes, which is the larger
 * change this defers. What makes one component serve both cases is `onNavigate`:
 *
 *   - given one (the shell), each item is a button that switches tab in place;
 *   - without one (`/papers`), each item is a link to `/?tab=…`, which the
 *     shell already reads on mount.
 *
 * So navigation works from everywhere without either side knowing which case
 * it is in.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { signOut, useSession } from 'next-auth/react';
import {
  BarChart3,
  Brain,
  ClipboardList,
  Database,
  GraduationCap,
  Home,
  Layers3,
  Library,
  LogIn,
  LogOut,
  MessagesSquare,
  Search,
  Settings,
  ShieldCheck,
  User,
  X,
} from 'lucide-react';

import { FEATURE_READINESS, isFeatureVisible } from '@/lib/feature-readiness';
import GlobalSearchPalette from './GlobalSearchPalette';

export type SidebarTab =
  | 'dashboard'
  | 'study'
  | 'practice'
  | 'materials'
  | 'mock-exams'
  | 'discussions';

/** `papers` is a real route rather than a tab, so it is named separately. */
export type SidebarSelection = SidebarTab | 'papers' | null;

const COLLAPSE_KEY = 'ykpao.sidebar.collapsed';

/**
 * The collapse preference, read straight from storage.
 *
 * `useSyncExternalStore` rather than an effect that copies localStorage into
 * state: the server renders this component too, so the initial value has to be
 * a stable `false` and the client value has to arrive without a hydration
 * mismatch. It also gets cross-tab sync for nothing, since `storage` fires in
 * every other tab of the same origin.
 */
const collapseListeners = new Set<() => void>();

function subscribeCollapse(onChange: () => void) {
  collapseListeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    collapseListeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function readCollapse() {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    // Private windows and blocked site data are not an error worth surfacing.
    return false;
  }
}

/** The server has no preference to read, and must agree with the first paint. */
function readCollapseOnServer() {
  return false;
}

/**
 * Collapse and drawer state, shared so it survives a route change.
 *
 * Without persistence, collapsing the sidebar in the shell and then opening
 * Past Papers would spring it back to full width -- the state lived in one
 * page component and the other route had never heard of it.
 */
export function useSidebarChrome() {
  const collapsedPreference = useSyncExternalStore(
    subscribeCollapse,
    readCollapse,
    readCollapseOnServer,
  );
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleCollapsed = useCallback(() => {
    try {
      window.localStorage.setItem(COLLAPSE_KEY, readCollapse() ? '0' : '1');
    } catch {
      // Preference is a convenience; failing to store it changes nothing now.
    }
    collapseListeners.forEach((listener) => listener());
  }, []);

  return {
    collapsedPreference,
    // Collapsing is a desktop affordance. While the mobile drawer is open the
    // sidebar is always shown expanded, so labels do not stay `sr-only` inside
    // a full-width drawer just because the user collapsed it on a larger screen.
    collapsed: collapsedPreference && !mobileOpen,
    toggleCollapsed,
    mobileOpen,
    openMobile: useCallback(() => setMobileOpen(true), []),
    closeMobile: useCallback(() => setMobileOpen(false), []),
  };
}

export function NavBadge({
  feature,
  collapsed,
}: {
  feature: keyof typeof FEATURE_READINESS;
  collapsed: boolean;
}) {
  const readiness = FEATURE_READINESS[feature];
  if (readiness.state !== 'preview' || collapsed) return null;
  return (
    <span className="ml-auto rounded-full bg-warning-subtle px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">
      {readiness.badge}
    </span>
  );
}

/** Scrim behind the mobile drawer. Desktop never renders it. */
export function SidebarScrim({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-40 bg-surface/50 backdrop-blur-sm lg:hidden"
      onClick={onClose}
      aria-hidden="true"
    />
  );
}

type Props = {
  active: SidebarSelection;
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  /**
   * Switch tab in place. Omit on routes outside the shell, where every item
   * becomes a link into it instead.
   */
  onNavigate?: (tab: SidebarTab) => void;
};

export default function AppSidebar({
  active,
  collapsed,
  mobileOpen,
  onCloseMobile,
  onNavigate,
}: Props) {
  const { data: session, status } = useSession();
  const [accountOpen, setAccountOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Cmd+K (or Ctrl+K on Windows/Linux) opens the global search palette from
  // anywhere the sidebar is mounted, matching the convention most students
  // already know from other apps.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const isSessionLoading = status === 'loading';
  const isAuthenticated = status === 'authenticated';
  const user = session?.user as
    | { name?: string | null; email?: string | null; image?: string | null; isAdmin?: boolean }
    | undefined;
  const userInitials = (user?.name ?? user?.email ?? 'S')
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const itemClass = (isActive: boolean) =>
    `w-full flex items-center ${collapsed ? 'justify-center px-0' : 'space-x-3 px-4'} py-3 text-sm font-medium rounded-lg transition-all duration-200 ${
      isActive
        ? 'bg-accent text-white'
        : 'text-secondary hover:bg-surface-hover'
    }`;
  const labelClass = collapsed ? 'sr-only' : '';

  const navItem = (
    tab: SidebarTab,
    label: string,
    Icon: typeof Home,
    badge?: keyof typeof FEATURE_READINESS,
  ) => (
    <NavItem
      key={tab}
      tab={tab}
      label={label}
      Icon={Icon}
      badge={badge}
      className={itemClass(active === tab)}
      labelClass={labelClass}
      collapsed={collapsed}
      onNavigate={onNavigate}
      onCloseMobile={onCloseMobile}
    />
  );

  return (
    <>
    <GlobalSearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    <aside
      className={`fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col bg-white/60 dark:bg-gray-900/40 backdrop-blur-2xl backdrop-saturate-150 border-r border-white/30 dark:border-white/10 shadow-overlay transition-transform duration-300 lg:static lg:max-w-none lg:translate-x-0 lg:transition-all ${
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      } ${collapsed ? 'lg:w-20' : 'lg:w-64'}`}
    >
      {/* Dismiss control for the mobile drawer; the desktop column has no
          overlay to escape from, so it is hidden from `lg` up. */}
      <button
        onClick={onCloseMobile}
        className="absolute right-3 top-3 rounded-md p-2 text-muted hover:bg-surface-hover lg:hidden"
        aria-label="Close navigation"
      >
        <X className="h-5 w-5" />
      </button>

      <div className={`${collapsed ? 'p-4' : 'p-6'} border-b border-white/30 dark:border-white/10`}>
        {/* A button (or link), not a clickable div: as a div it was invisible
            to keyboard and screen-reader users even though it is the app's
            "home" control. */}
        {onNavigate ? (
          <button
            type="button"
            onClick={() => onNavigate('dashboard')}
            aria-label="YKPao Study — go to dashboard"
            className={`flex w-full items-center ${collapsed ? 'justify-center' : 'space-x-3'} cursor-pointer group rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/25`}
          >
            <BrandMark collapsed={collapsed} />
          </button>
        ) : (
          <Link
            href="/"
            aria-label="YKPao Study — go to dashboard"
            className={`flex w-full items-center ${collapsed ? 'justify-center' : 'space-x-3'} cursor-pointer group rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/25`}
          >
            <BrandMark collapsed={collapsed} />
          </Link>
        )}
      </div>

      <nav className={`${collapsed ? 'px-2' : 'px-4'} flex-1 space-y-2 overflow-y-auto py-6`}>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          title="Search (⌘K)" aria-label="Search (⌘K)"
          className={`w-full flex items-center ${collapsed ? 'justify-center px-0' : 'justify-between px-4'} py-3 text-sm font-medium rounded-lg text-secondary hover:bg-surface-hover transition-all duration-200`}
        >
          <span className={`flex items-center ${collapsed ? '' : 'space-x-3'}`}>
            <Search className="w-5 h-5" />
            <span className={labelClass}>Search</span>
          </span>
          {!collapsed && (
            <span className="rounded-md border border-line px-1.5 py-0.5 text-[10px] font-medium text-muted">
              ⌘K
            </span>
          )}
        </button>
        {navItem('dashboard', 'Dashboard', Home)}
        {navItem('study', 'Study', Brain)}
        {isFeatureVisible('question-bank') &&
          navItem('practice', 'Practice', Database, 'question-bank')}

        {/* Past papers is its own route rather than a tab, because the PDF
            viewer at /papers/[id] navigates away from the shell anyway. */}
        <Link
          href="/papers"
          title="Past Papers" aria-label="Past Papers"
          className={itemClass(active === 'papers')}
          onClick={onCloseMobile}
        >
          <Library className="w-5 h-5" />
          <span className={labelClass}>Past Papers</span>
        </Link>

        {navItem('materials', 'Materials', Layers3)}
        {isFeatureVisible('mock-exams') &&
          navItem('mock-exams', 'Mock Exams', ClipboardList, 'mock-exams')}
        {navItem('discussions', 'Discussion Board', MessagesSquare)}
      </nav>

      <div className={`${collapsed ? 'px-2 py-4' : 'p-4'} border-t border-white/30 dark:border-white/10`}>
        {isSessionLoading ? (
          // A placeholder, not the signed-out buttons: offering "Sign In" to
          // someone who is already signed in is the whole bug.
          <div className={`flex items-center ${collapsed ? 'justify-center' : 'space-x-3 px-3'} py-3`}>
            <div className="h-10 w-10 flex-shrink-0 animate-pulse rounded-lg bg-surface-active" />
            {!collapsed && (
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-24 animate-pulse rounded-sm bg-surface-active" />
                <div className="h-2.5 w-32 animate-pulse rounded-sm bg-surface-raised" />
              </div>
            )}
          </div>
        ) : isAuthenticated ? (
          <div className="relative">
            <button
              onClick={() => setAccountOpen(!accountOpen)}
              title={user?.name ?? 'Account'} aria-label={user?.name ?? 'Account'}
              className={`w-full flex items-center ${collapsed ? 'justify-center px-0 py-3' : 'space-x-3 px-3 py-3'} rounded-lg hover:bg-surface-hover transition-all duration-200 focus:outline-none`}
            >
              <div className="w-10 h-10 rounded-lg bg-accent flex items-center justify-center text-white font-semibold text-sm overflow-hidden">
                {user?.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={user.image} alt={user.name ?? 'User'} className="w-full h-full object-cover" />
                ) : (
                  userInitials
                )}
              </div>
              {!collapsed && (
                <>
                  <div className="flex-1 min-w-0 text-left">
                    <p className="text-sm font-semibold text-primary truncate">{user?.name ?? 'Student'}</p>
                    <p className="text-xs text-muted truncate">{user?.email}</p>
                  </div>
                  <Settings className="w-4 h-4 flex-shrink-0 text-muted" />
                </>
              )}
            </button>

            {accountOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setAccountOpen(false)} />
                <div className={`absolute bottom-full mb-2 bg-surface border border-line rounded-lg shadow-overlay py-2 z-50 ${collapsed ? 'left-0 w-72' : 'left-0 right-0'}`}>
                  <div className="px-4 py-3 border-b border-subtle">
                    <p className="text-sm font-semibold text-primary truncate">{user?.name ?? 'Student Account'}</p>
                    <p className="text-xs text-muted truncate mt-0.5">{user?.email}</p>
                  </div>
                  <div className="py-1">
                    <a
                      href="/account"
                      className="w-full flex items-center space-x-3 px-4 py-2.5 text-sm text-secondary hover:bg-surface-hover transition-colors"
                    >
                      <User className="w-4 h-4" />
                      <span>Account Settings</span>
                    </a>
                    <a
                      href="/usage"
                      className="w-full flex items-center space-x-3 px-4 py-2.5 text-sm text-secondary hover:bg-surface-hover transition-colors"
                    >
                      <BarChart3 className="w-4 h-4" />
                      <span>Usage &amp; API Credits</span>
                    </a>
                    {user?.isAdmin && (
                      <a
                        href="/admin"
                        className="w-full flex items-center space-x-3 px-4 py-2.5 text-sm text-secondary hover:bg-surface-hover transition-colors font-medium"
                      >
                        <ShieldCheck className="w-4 h-4" />
                        <span>Admin Console</span>
                      </a>
                    )}
                  </div>
                  <div className="border-t border-subtle mt-1 pt-1">
                    <button
                      onClick={async () => {
                        await signOut({
                          redirect: false,
                          callbackUrl: `${window.location.origin}/`,
                        });
                        window.location.assign('/');
                      }}
                      className="w-full flex items-center space-x-3 px-4 py-2.5 text-sm text-danger hover:bg-danger-subtle transition-colors font-medium"
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
              title="Sign In" aria-label="Sign In"
              className={`w-full flex items-center ${collapsed ? 'justify-center px-0' : 'justify-center space-x-2 px-4'} py-3 text-sm font-semibold text-white bg-accent rounded-lg transition-all duration-200`}
            >
              <LogIn className="w-4 h-4" />
              <span className={collapsed ? 'sr-only' : ''}>Sign In</span>
            </Link>
            <Link
              href="/auth/signup"
              title="Create Account" aria-label="Create Account"
              className={`w-full flex items-center ${collapsed ? 'justify-center px-0' : 'justify-center space-x-2 px-4'} py-3 text-sm font-medium text-secondary bg-surface border border-line rounded-lg hover:bg-surface-hover transition-all duration-200`}
            >
              <User className="w-4 h-4" />
              <span className={collapsed ? 'sr-only' : ''}>Create Account</span>
            </Link>
          </div>
        )}
      </div>
    </aside>
    </>
  );
}

/**
 * One navigation item, rendered as whichever control the context can honour.
 *
 * Declared at module scope rather than inside the sidebar: a component created
 * during render is a new type on every pass, so React unmounts and remounts the
 * whole subtree instead of updating it.
 */
function NavItem({
  tab,
  label,
  Icon,
  badge,
  className,
  labelClass,
  collapsed,
  onNavigate,
  onCloseMobile,
}: {
  tab: SidebarTab;
  label: string;
  Icon: typeof Home;
  badge?: keyof typeof FEATURE_READINESS;
  className: string;
  labelClass: string;
  collapsed: boolean;
  onNavigate?: (tab: SidebarTab) => void;
  onCloseMobile: () => void;
}) {
  const body = (
    <>
      <Icon className="w-5 h-5" />
      <span className={labelClass}>{label}</span>
      {badge && <NavBadge feature={badge} collapsed={collapsed} />}
    </>
  );

  if (onNavigate) {
    return (
      <button onClick={() => onNavigate(tab)} title={label} aria-label={label} className={className}>
        {body}
      </button>
    );
  }
  return (
    <Link href={`/?tab=${tab}`} title={label} aria-label={label} className={className} onClick={onCloseMobile}>
      {body}
    </Link>
  );
}

function BrandMark({ collapsed }: { collapsed: boolean }) {
  return (
    <>
      <div className="w-10 h-10 bg-accent rounded-lg flex items-center justify-center transition-all duration-300 group-hover:scale-105">
        <GraduationCap className="w-6 h-6 text-white" />
      </div>
      <span
        className={`${collapsed ? 'sr-only' : 'text-xl'} font-bold text-primary`}
      >
        YKPao Study
      </span>
    </>
  );
}
