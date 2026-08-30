'use client';

/**
 * The shell around Past Papers.
 *
 * `/papers` and `/papers/[id]` are real routes rather than tabs of
 * `app/page.tsx`, and the navigation used to live inside that page -- so these
 * two rendered with none. A student who followed Past Papers from the sidebar
 * arrived somewhere with no sidebar, no account menu and no way back except
 * the browser's own Back button. Past Papers is the launch surface, so that
 * was the first thing a beta student would have hit.
 *
 * This is deliberately not the wider routing rework: the tabs are still tab
 * state in the shell. It puts the same navigation on the routes that were
 * missing it, and each item links to `/?tab=…`, which the shell already reads
 * on mount.
 */

import { Menu, PanelLeft, PanelLeftClose } from 'lucide-react';

import AppSidebar, { SidebarScrim, useSidebarChrome } from '@/app/components/AppSidebar';
import NotificationBell from '@/app/components/NotificationBell';
import ThemeToggle from '@/app/components/ThemeToggle';

export default function PapersLayout({ children }: { children: React.ReactNode }) {
  const { collapsed, collapsedPreference, toggleCollapsed, mobileOpen, openMobile, closeMobile } =
    useSidebarChrome();

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-900">
      <SidebarScrim open={mobileOpen} onClose={closeMobile} />

      <AppSidebar
        active="papers"
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={closeMobile}
      />

      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="flex items-center justify-between px-6 py-4 bg-white/50 dark:bg-gray-900/40 backdrop-blur-2xl backdrop-saturate-150 border-b border-white/30 dark:border-white/10 shadow-sm">
          <div className="flex items-center space-x-4">
            <button
              onClick={openMobile}
              className="p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors lg:hidden"
              aria-label="Open navigation"
              aria-expanded={mobileOpen}
            >
              <Menu className="w-5 h-5 text-gray-600 dark:text-gray-400" />
            </button>

            <button
              onClick={toggleCollapsed}
              className="hidden p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors lg:block"
              aria-label={collapsedPreference ? 'Expand sidebar' : 'Collapse sidebar'}
              title={collapsedPreference ? 'Show sidebar' : 'Hide sidebar'}
            >
              {collapsedPreference ? (
                <PanelLeft className="w-5 h-5 text-gray-600 dark:text-gray-400" />
              ) : (
                <PanelLeftClose className="w-5 h-5 text-gray-600 dark:text-gray-400" />
              )}
            </button>

            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">Past Papers</h1>
          </div>

          <div className="flex items-center space-x-4">
            <ThemeToggle />
            <NotificationBell />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
