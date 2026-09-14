'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  LayoutDashboard, Users, ShieldCheck, Megaphone,
  FolderOpen, Activity, ArrowLeft, Menu, X, Wallet,
} from 'lucide-react';
import AdminDashboard from './sections/AdminDashboard';
import UserManagement from './sections/UserManagement';
import ContentModeration from './sections/ContentModeration';
import AnnouncementManager from './sections/AnnouncementManager';
import ResourceManager from './sections/ResourceManager';
import SystemMonitor from './sections/SystemMonitor';
import AiAccessManager from './sections/AiAccessManager';

type Section =
  | 'dashboard'
  | 'users'
  | 'ai-access'
  | 'moderation'
  | 'announcements'
  | 'resources'
  | 'system';

const NAV: { key: Section; label: string; icon: typeof LayoutDashboard }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { key: 'users', label: 'Users', icon: Users },
  { key: 'ai-access', label: 'AI Access', icon: Wallet },
  { key: 'moderation', label: 'Moderation', icon: ShieldCheck },
  { key: 'announcements', label: 'Announcements', icon: Megaphone },
  { key: 'resources', label: 'Resources', icon: FolderOpen },
  { key: 'system', label: 'System', icon: Activity },
];

export default function AdminPanel() {
  const [section, setSection] = useState<Section>('dashboard');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100 flex">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:sticky top-0 left-0 h-screen w-64 bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col z-40 transition-transform duration-200 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="p-5 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 bg-accent rounded-lg flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-sm">Admin Console</h1>
              <p className="text-[10px] text-gray-500">Super Administrator</p>
            </div>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="lg:hidden p-1 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {NAV.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => {
                setSection(key);
                setSidebarOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                section === key
                  ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {label}
            </button>
          ))}
        </nav>

        <div className="p-3 border-t border-gray-200 dark:border-gray-800">
          <Link
            href="/"
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <ArrowLeft className="w-4 h-4 flex-shrink-0" />
            Back to App
          </Link>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top bar (mobile) */}
        <header className="lg:hidden sticky top-0 z-20 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1.5 text-gray-500 hover:text-gray-700 dark:hover:text-gray-200 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="font-semibold text-sm">Admin Console</span>
        </header>

        <main className="flex-1 p-4 lg:p-8 overflow-x-hidden">
          {section === 'dashboard' && <AdminDashboard />}
          {section === 'users' && <UserManagement />}
          {section === 'ai-access' && <AiAccessManager />}
          {section === 'moderation' && <ContentModeration />}
          {section === 'announcements' && <AnnouncementManager />}
          {section === 'resources' && <ResourceManager />}
          {section === 'system' && <SystemMonitor />}
        </main>
      </div>
    </div>
  );
}
