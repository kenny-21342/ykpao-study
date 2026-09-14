'use client';

import { useId } from 'react';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cn } from './cn';

/**
 * A labelled form control.
 *
 * The app had three spellings of the same form label (differing only in
 * `mb-1.5` vs `mb-2` and whether the dark variant was remembered) and three
 * spellings of the same text input (two background colours, three padding
 * scales, two focus-ring colours). That is what happens when the only way to
 * make a field is to retype one.
 *
 * Field owns the parts that are easy to forget rather than hard to type: the
 * label's `htmlFor`, `aria-describedby` for the hint, `aria-invalid` and the
 * error wiring. Those were missing far more often than they were present.
 */

const CONTROL =
  'w-full rounded-md border border-strong bg-surface px-3 text-sm text-primary ' +
  'placeholder:text-muted transition-colors ' +
  'focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring/25 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

const INVALID = 'border-danger focus-visible:border-danger focus-visible:ring-danger/25';

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  /** Receives the ids to wire onto the control. */
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
  className?: string;
}) {
  const base = useId();
  const id = `${base}-control`;
  const hintId = hint ? `${base}-hint` : undefined;
  const errorId = error ? `${base}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={id} className="block text-sm font-medium text-primary mb-1.5">
        {label}
        {required && (
          <span className="text-danger ml-0.5" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error ? (
        <p id={errorId} className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="mt-1.5 text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Input({
  invalid,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      className={cn(CONTROL, 'h-9', invalid && INVALID, className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export function Textarea({
  invalid,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      className={cn(CONTROL, 'py-2 min-h-20 resize-y', invalid && INVALID, className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export function Select({
  invalid,
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      className={cn(CONTROL, 'h-9 pr-8', invalid && INVALID, className)}
      aria-invalid={invalid || undefined}
      {...rest}
    >
      {children}
    </select>
  );
}

/**
 * Checkbox carries its own label, because a checkbox whose label is not
 * clickable is a checkbox that is hard to hit on a phone.
 */
export function Checkbox({
  label,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode }) {
  const id = useId();
  return (
    <div className={cn('flex items-start gap-2', className)}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded-sm border-strong text-accent accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        {...rest}
      />
      <label htmlFor={id} className="text-sm text-primary select-none">
        {label}
      </label>
    </div>
  );
}
