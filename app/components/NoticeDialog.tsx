'use client';

import { useEffect } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Info,
  TriangleAlert,
  X,
} from 'lucide-react';

type NoticeTone = 'info' | 'success' | 'warning' | 'error';

const TONE_META: Record<NoticeTone, { icon: typeof Info; accent: string; iconBg: string; border: string }> = {
  info: {
    icon: Info,
    accent: 'text-blue-700 dark:text-blue-300',
    iconBg: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
    border: 'border-blue-200 dark:border-blue-900/50',
  },
  success: {
    icon: CheckCircle2,
    accent: 'text-green-700 dark:text-green-300',
    iconBg: 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300',
    border: 'border-green-200 dark:border-green-900/50',
  },
  warning: {
    icon: TriangleAlert,
    accent: 'text-amber-700 dark:text-amber-300',
    iconBg: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
    border: 'border-amber-200 dark:border-amber-900/50',
  },
  error: {
    icon: AlertCircle,
    accent: 'text-red-700 dark:text-red-300',
    iconBg: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
    border: 'border-red-200 dark:border-red-900/50',
  },
};

type NoticeDialogProps = {
  open: boolean;
  title: string;
  message: string;
  tone?: NoticeTone;
  onClose: () => void;
};

export default function NoticeDialog({
  open,
  title,
  message,
  tone = 'info',
  onClose,
}: NoticeDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const meta = TONE_META[tone];
  const Icon = meta.icon;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="notice-dialog-title"
        aria-describedby="notice-dialog-message"
        className={`w-full max-w-md overflow-hidden rounded-2xl border bg-white shadow-2xl dark:bg-gray-800 ${meta.border}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 py-4">
          <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${meta.iconBg}`}>
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="notice-dialog-title" className={`text-base font-bold ${meta.accent}`}>
              {title}
            </h2>
            <p id="notice-dialog-message" className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              {message}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            aria-label="Close message"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex justify-end border-t border-gray-100 px-5 py-4 dark:border-gray-700">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
