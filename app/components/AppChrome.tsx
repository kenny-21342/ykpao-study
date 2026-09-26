'use client';

/**
 * The application shell for routes that are real routes rather than tabs of
 * `app/page.tsx`.
 *
 * Six routes are reached from the sidebar but render outside the shell that
 * draws it: `/papers`, `/bank`, `/account`, `/usage` and `/announcements`. A
 * student who followed any of them arrived somewhere with no sidebar, no
 * account menu and no way back except the browser's own Back button. Only
 * `/papers` had ever been given the chrome, by copying it into a layout; this
 * is that layout extracted so the other four get it without a fifth copy.
 *
 * Deliberately not the wider routing rework: the tabs are still tab state in
 * the shell, and each sidebar item links to `/?tab=…`, which the shell already
 * reads on mount.
 *
 * No title is rendered here. Every page inside already owns an <h1>, and
 * `/papers` proved the point by shipping two of them — one in this header and
 * one in PaperBrowser, both reading "Past Papers".
 */

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Menu, PanelLeft, PanelLeftClose, Sparkles } from 'lucide-react';

import AppSidebar, {
  SidebarScrim,
  useSidebarChrome,
  type SidebarSelection,
} from '@/app/components/AppSidebar';
import FloatingAIAssistant from '@/app/components/FloatingAIAssistant';
import NotificationBell from '@/app/components/NotificationBell';
import { ScreenContextProvider } from '@/app/components/ScreenContext';
import ThemeToggle from '@/app/components/ThemeToggle';
import { resolveRoute, routeToQuery, type StudyCoachView } from '@/app/components/routing';

export default function AppChrome({
  active,
  children,
}: {
  active: SidebarSelection;
  children: React.ReactNode;
}) {
  const { collapsed, collapsedPreference, toggleCollapsed, mobileOpen, openMobile, closeMobile } =
    useSidebarChrome();
  const router = useRouter();

  // The tutor lives here as well as in `HomeShell`.
  //
  // It used to be mounted only in the tab shell, so the five routes that are
  // real routes had no tutor at all -- including /papers/[id] and
  // /bank/papers/[id], which are where a student is most likely to be stuck on
  // something and least able to describe it. `PaperViewer` has been reporting
  // its screen context to nothing for exactly that reason.
  //
  // Two mounts, not one shared instance: these are separate route trees, so
  // they never render together and there is no double toolbar or duplicate
  // conversation. Hoisting it to the root layout instead would put a tutor on
  // the landing page, /terms and the auth screens, which are signed out.
  const [assistantOpen, setAssistantOpen] = useState(false);

  // `FloatingAIAssistant.navigate` emits exactly { tab, questionId, view }, so
  // that is what this reads -- no `bankQuestionId`, even though `routeToQuery`
  // can express one.
  const handleNavigate = useCallback((event: Event) => {
    const detail = (event as CustomEvent<{ tab?: string; questionId?: number; view?: StudyCoachView }>).detail;
    const route = resolveRoute(detail?.tab ?? null);
    if (!route) return;
    setAssistantOpen(false);
    // There is no tab state to set out here, so a citation navigates to the
    // shell and lets it read the query on mount -- the same contract the
    // sidebar links already use. `routeToQuery` keeps the parameter spelling
    // canonical rather than hand-built.
    router.push(`/?${routeToQuery({
      ...route,
      ...(detail?.view ? { studyView: detail.view } : {}),
      ...(detail?.questionId ? { questionId: detail.questionId } : {}),
    })}`);
  }, [router]);

  useEffect(() => {
    const open = () => setAssistantOpen(true);
    window.addEventListener('open-ai-assistant', open);
    window.addEventListener('ai-navigate', handleNavigate);
    return () => {
      window.removeEventListener('open-ai-assistant', open);
      window.removeEventListener('ai-navigate', handleNavigate);
    };
  }, [handleNavigate]);

  return (
    <ScreenContextProvider>
      <div className="flex h-screen overflow-hidden bg-canvas">
        <SidebarScrim open={mobileOpen} onClose={closeMobile} />

        <AppSidebar
          active={active}
          collapsed={collapsed}
          mobileOpen={mobileOpen}
          onCloseMobile={closeMobile}
        />

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex items-center justify-between gap-4 border-b border-line bg-surface/80 px-4 py-3 backdrop-blur-xl sm:px-6">
            <div className="flex items-center gap-1">
              <button
                onClick={openMobile}
                className="rounded-md p-2 transition-colors hover:bg-surface-hover lg:hidden"
                aria-label="Open navigation"
                aria-expanded={mobileOpen}
              >
                <Menu className="h-5 w-5 text-secondary" />
              </button>

              <button
                onClick={toggleCollapsed}
                className="hidden rounded-md p-2 transition-colors hover:bg-surface-hover lg:block"
                aria-label={collapsedPreference ? 'Expand sidebar' : 'Collapse sidebar'}
                title={collapsedPreference ? 'Show sidebar' : 'Hide sidebar'}
              >
                {collapsedPreference ? (
                  <PanelLeft className="h-5 w-5 text-secondary" />
                ) : (
                  <PanelLeftClose className="h-5 w-5 text-secondary" />
                )}
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setAssistantOpen((open) => !open)}
                className={`rounded-lg p-2 transition-colors ${
                  assistantOpen ? 'bg-accent text-white' : 'text-secondary hover:bg-surface-hover'
                }`}
                title="AI Tutor"
                aria-label="AI Tutor"
                aria-expanded={assistantOpen}
              >
                <Sparkles className="h-5 w-5" />
              </button>
              <ThemeToggle />
              <NotificationBell />
            </div>
          </header>

          {/* The one scroll container. Pages inside must not carry `min-h-screen`
              -- inside a scrolling box it pins them to 100vh regardless of their
              content, which is what produced the double scrollbar on /papers. */}
          <div className="flex-1 overflow-y-auto">{children}</div>
        </div>

        <FloatingAIAssistant isOpen={assistantOpen} onClose={() => setAssistantOpen(false)} />
      </div>
    </ScreenContextProvider>
  );
}
