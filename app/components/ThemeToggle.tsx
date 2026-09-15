'use client';

import { Sun, Moon } from 'lucide-react';

type Theme = 'light' | 'dark';

const getCurrentTheme = (): Theme => {
  const root = document.documentElement;
  return root.dataset.theme === 'dark' || root.classList.contains('dark') ? 'dark' : 'light';
};

const applyTheme = (nextTheme: Theme) => {
  const root = document.documentElement;
  root.classList.toggle('dark', nextTheme === 'dark');
  root.dataset.theme = nextTheme;
  root.style.colorScheme = nextTheme;
  try {
    localStorage.setItem('theme', nextTheme);
  } catch {}
};

export default function ThemeToggle() {
  const toggleTheme = () => {
    const newTheme = getCurrentTheme() === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
  };

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="p-2 rounded-md hover:bg-surface-hover transition-colors"
      aria-label="Toggle color theme"
      title="Toggle color theme"
    >
      <Moon className="w-5 h-5 text-secondary dark:hidden" />
      <Sun className="hidden w-5 h-5 text-muted dark:block" />
    </button>
  );
}
