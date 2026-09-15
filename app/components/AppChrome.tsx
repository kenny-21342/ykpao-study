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

import { Menu, PanelLeft, PanelLeftClose } from 'lucide-react';

import AppSidebar, {
  SidebarScrim,
  useSidebarChrome,
  type SidebarSelection,
} from '@/app/components/AppSidebar';
import NotificationBell from '@/app/components/NotificationBell';
import ThemeToggle from '@/app/components/ThemeToggle';

export default function AppChrome({
  active,
  children,
}: {
  active: SidebarSelection;
  children: React.ReactNode;
}) {
  const { collapsed, collapsedPreference, toggleCollapsed, mobileOpen, openMobile, closeMobile } =
    useSidebarChrome();

  return (
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
            <ThemeToggle />
            <NotificationBell />
          </div>
        </header>

        {/* The one scroll container. Pages inside must not carry `min-h-screen`
            -- inside a scrolling box it pins them to 100vh regardless of their
            content, which is what produced the double scrollbar on /papers. */}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
