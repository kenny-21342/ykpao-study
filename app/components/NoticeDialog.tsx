'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Loader2,
  TriangleAlert,
  X,
} from 'lucide-react';

/**
 * The app's one modal dialog, in two shapes.
 *
 * As a **notice** it is what it always was: a message and an OK button, the
 * replacement for `alert()`.
 *
 * As a **confirm** -- pass `onConfirm` -- it is the replacement for
 * `window.confirm()`, which the app still used in eleven places. A native
 * confirm is worth replacing for three separate reasons, and the third is the
 * one that made this urgent:
 *
 *  1. It cannot say what is actually being lost. `confirm('Are you sure?')`
 *     is the whole vocabulary; a dialog can name the page, the exam, the
 *     account.
 *  2. It is unstyled OS chrome in the middle of a designed app, and on mobile
 *     it is a system sheet that looks like it came from somewhere else.
 *  3. **It blocks the event loop.** One of the sites it guarded fires during a
 *     timed exam, where a blocking dialog freezes the timer, the autosave and
 *     the SSE connection until the student notices and dismisses it.
 *
 * Focus handling lives here rather than at each call site, so fixing it once
 * fixes every modal in the app: focus moves into the dialog on open, Tab is
 * trapped inside it, and on close it returns to whatever the student was on
 * before -- without which a keyboard user is dropped at the top of the
 * document every time they dismiss something.
 */

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
  /** A string, or richer content when the message needs a list or emphasis. */
  message: React.ReactNode;
  tone?: NoticeTone;
  /** Dismiss. For a confirm dialog this is Cancel. */
  onClose: () => void;

  // --- Confirm variant -----------------------------------------------------
  /** Supplying this turns the dialog into a confirmation. */
  onConfirm?: () => void;
  /** Label for the action button. Say what will happen: "Delete page". */
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * Styles the action button as destructive **and** focuses Cancel instead of
   * it on open, so Enter cannot complete a deletion the student never read.
   */
  destructive?: boolean;
  /** Disables both buttons and spins the action while the work is in flight. */
  busy?: boolean;

  // --- Prompt variant ------------------------------------------------------
  /**
   * Turns the confirm into a prompt: renders a labelled text field and hands
   * its value to `onConfirm`. Replaces `window.prompt()`, which is the worst
   * of the three native dialogs -- blocking like the others, and on a phone an
   * OS sheet that looks like it belongs to a different application.
   */
  inputLabel?: string;
  inputPlaceholder?: string;
  /** Disables the action button until the field has something in it. */
  inputRequired?: boolean;
  onConfirmValue?: (value: string) => void;
};

/** Focusable descendants, in document order. */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])';

export default function NoticeDialog({
  open,
  title,
  message,
  tone = 'info',
  onClose,
  onConfirm,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  inputLabel,
  inputPlaceholder,
  inputRequired = false,
  onConfirmValue,
}: NoticeDialogProps) {
  /**
   * Closed is a null render, not an unmount, so this state would otherwise
   * survive from one dialog to the next and the field would open holding the
   * last thing typed into it -- possibly on a different thread entirely.
   * `useConfirm` gives the element a fresh `key` per open instead, which
   * remounts the component and starts everything here clean.
   */
  const [inputValue, setInputValue] = useState('');
  // Unique per instance: the ids used to be constants, so two mounted dialogs
  // produced duplicate ids and a screen reader could announce the wrong one.
  const id = useId();
  const titleId = `${id}-title`;
  const messageId = `${id}-message`;
  const inputId = `${id}-input`;

  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  /** Whatever had focus before the dialog opened, to give it back. */
  const restoreRef = useRef<HTMLElement | null>(null);

  const isConfirm = typeof onConfirm === 'function' || typeof onConfirmValue === 'function';
  const isPrompt = typeof inputLabel === 'string';
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = useCallback(() => {
    if (onConfirmValue) onConfirmValue(inputValue);
    else onConfirm?.();
  }, [inputValue, onConfirm, onConfirmValue]);

  // Never let a dismissal fire while the confirmed action is running -- a
  // backdrop click or Escape mid-delete would unmount the dialog and leave the
  // student with no indication of whether it finished.
  const dismiss = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  useEffect(() => {
    if (!open) return;

    restoreRef.current = document.activeElement as HTMLElement | null;

    // A destructive dialog opens on Cancel. Anyone who hits Enter out of habit
    // -- which is exactly how a native confirm gets dismissed -- then cancels
    // rather than deletes.
    // A prompt opens on its field -- there is nothing to read first, and the
    // student is there to type. Otherwise a destructive dialog opens on Cancel.
    const initial = inputRef.current
      ? inputRef.current
      : destructive || !isConfirm
        ? cancelRef.current ?? confirmRef.current
        : confirmRef.current;
    (initial ?? panelRef.current)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dismiss();
        return;
      }
      if (e.key !== 'Tab') return;

      // Trap: without this, Tab walks out of the dialog into the page behind
      // it, which is still rendered and still focusable.
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      // Back where they were. Guarded because the trigger may have unmounted
      // along with the thing it acted on -- a deleted row's own button.
      const restore = restoreRef.current;
      if (restore && document.contains(restore)) restore.focus();
    };
  }, [open, destructive, isConfirm, dismiss]);

  if (!open) return null;

  const meta = TONE_META[destructive ? 'error' : tone];
  const Icon = meta.icon;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={dismiss}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        className={`w-full max-w-md overflow-hidden rounded-lg border bg-white shadow-2xl outline-none dark:bg-gray-800 ${meta.border}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 py-4">
          <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg ${meta.iconBg}`}>
            <Icon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className={`text-base font-bold ${meta.accent}`}>
              {title}
            </h2>
            <div id={messageId} className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              {message}
            </div>
          </div>
          <button
            type="button"
            onClick={dismiss}
            disabled={busy}
            className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            aria-label="Close message"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {isPrompt && (
          <div className="px-5 pb-2">
            <label
              htmlFor={inputId}
              className="block text-xs font-semibold text-gray-600 dark:text-gray-300"
            >
              {inputLabel}
            </label>
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              value={inputValue}
              placeholder={inputPlaceholder}
              disabled={busy}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                // Enter submits, as it does in a native prompt.
                if (e.key === 'Enter' && (!inputRequired || inputValue.trim())) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="mt-1.5 w-full rounded-md border border-gray-300 px-3 py-2 text-sm outline-none focus:border-gray-500 disabled:opacity-60 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-4 dark:border-gray-700">
          <button
            ref={cancelRef}
            type="button"
            onClick={dismiss}
            disabled={busy}
            className={
              isConfirm
                ? 'inline-flex items-center gap-2 rounded-md border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700'
                : 'inline-flex items-center gap-2 rounded-md bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100'
            }
          >
            {isConfirm ? cancelLabel : 'OK'}
          </button>

          {isConfirm && (
            <button
              ref={confirmRef}
              type="button"
              onClick={submit}
              disabled={busy || (inputRequired && !inputValue.trim())}
              className={`inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-60 ${
                destructive
                  ? 'bg-red-600 hover:bg-red-700'
                  : 'bg-gray-900 hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100'
              }`}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
