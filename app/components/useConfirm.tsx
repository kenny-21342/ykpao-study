'use client';

import { useCallback, useRef, useState } from 'react';
import NoticeDialog from './NoticeDialog';

/**
 * `window.confirm()`, without the blocking native dialog.
 *
 * The eleven sites this replaces all had the same shape -- `if
 * (!confirm('...')) return;` at the top of a handler -- and the reason they
 * survived so long is that any replacement built out of component state turns
 * that one line into a piece of state, a pending-action ref, two handlers and
 * a rendered dialog, per site. Eleven times, that is how a migration gets
 * started and abandoned, which is exactly what happened once already
 * (`ResourceManager` was converted; nothing else was).
 *
 * So this keeps the shape:
 *
 *   if (!(await confirm({ title: 'Delete this page?', message: '...' }))) return;
 *
 * The handler becomes `async` and the rest of it is untouched.
 *
 * If the component unmounts while a dialog is open the promise simply never
 * settles, so the code after the `await` never runs. That is the correct
 * outcome -- there is nothing left to act on -- and it is why the resolver is
 * dropped rather than rejected: a rejection would surface as an unhandled
 * error for something the student did not do wrong.
 */

export type ConfirmOptions = {
  title: string;
  message: React.ReactNode;
  /** Say what will happen: "Delete page", not "OK". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red action button, and focus starts on Cancel. Default true. */
  destructive?: boolean;
};

export type PromptOptions = Omit<ConfirmOptions, 'destructive'> & {
  /** Names the field. Its presence is what makes the dialog a prompt. */
  inputLabel: string;
  inputPlaceholder?: string;
  /** Blocks the action button until something is typed. Default true. */
  inputRequired?: boolean;
};

type Pending =
  | ({ kind: 'confirm' } & ConfirmOptions)
  | ({ kind: 'prompt' } & PromptOptions);

export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);
  const resolveRef = useRef<((value: never) => void) | null>(null);
  /**
   * Bumped on every open, and used as the dialog's `key`.
   *
   * A closed dialog is a null render rather than an unmount, so without this
   * the prompt's text field would carry whatever was typed into the previous
   * one. Remounting is both simpler and more complete than resetting each
   * piece of state by hand -- and resetting inside an effect is what React
   * flags as a cascading render.
   */
  const [openCount, setOpenCount] = useState(0);

  /**
   * A second call while one is open answers the first negatively rather than
   * stranding it, so the earlier handler exits cleanly.
   */
  const settle = useCallback((value: boolean | string | null) => {
    const resolve = resolveRef.current as ((v: boolean | string | null) => void) | null;
    resolveRef.current = null;
    setPending(null);
    resolve?.(value);
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        (resolveRef.current as ((v: boolean) => void) | null)?.(false);
        resolveRef.current = resolve as (value: never) => void;
        setOpenCount((n) => n + 1);
        setPending({ kind: 'confirm', ...options });
      }),
    [],
  );

  /** Resolves to the typed text, or null if the student cancelled. */
  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        (resolveRef.current as ((v: string | null) => void) | null)?.(null);
        resolveRef.current = resolve as (value: never) => void;
        setOpenCount((n) => n + 1);
        setPending({ kind: 'prompt', ...options });
      }),
    [],
  );

  const isPrompt = pending?.kind === 'prompt';

  const confirmDialog = (
    <NoticeDialog
      key={openCount}
      open={pending !== null}
      title={pending?.title ?? ''}
      message={pending?.message ?? ''}
      confirmLabel={pending?.confirmLabel ?? (isPrompt ? 'Submit' : 'Confirm')}
      cancelLabel={pending?.cancelLabel ?? 'Cancel'}
      // A prompt is never styled as destructive: it is asking for something,
      // not warning about something. A confirm is, unless it opts out --
      // every site this replaced was a delete or a data-loss warning, so
      // opting out for the two that are not is safer than opting in and
      // forgetting.
      destructive={pending?.kind === 'confirm' ? pending.destructive ?? true : false}
      inputLabel={isPrompt ? pending.inputLabel : undefined}
      inputPlaceholder={isPrompt ? pending.inputPlaceholder : undefined}
      inputRequired={isPrompt ? pending.inputRequired ?? true : undefined}
      onConfirm={isPrompt ? undefined : () => settle(true)}
      onConfirmValue={isPrompt ? (value) => settle(value) : undefined}
      // Cancelling a prompt is `null`, not `false`, so a caller can tell an
      // empty answer from no answer.
      onClose={() => settle(isPrompt ? null : false)}
    />
  );

  return { confirm, prompt, confirmDialog };
}
