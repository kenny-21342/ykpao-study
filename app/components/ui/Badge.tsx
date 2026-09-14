import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * A small status marker. Neutral by default, because most badges in this app
 * label a state rather than raise an alarm — the old ones reached for a
 * different accent colour each time, which is how a palette ends up with 17
 * families in it.
 */

export type BadgeTone = 'neutral' | 'accent' | 'warning' | 'danger';

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-line bg-surface-raised text-secondary',
  accent: 'border-accent-border bg-accent-subtle text-accent-text',
  warning: 'border-warning-border bg-warning-subtle text-warning',
  danger: 'border-danger-border bg-danger-subtle text-danger',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5',
        'text-xs font-medium leading-none whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
