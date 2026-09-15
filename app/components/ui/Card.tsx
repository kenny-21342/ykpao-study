import type { ReactNode } from 'react';
import { cn } from './cn';

/**
 * The card that was never written.
 *
 * Thirty-eight of these shells were retyped by hand across the app, which is
 * why four different border radii ended up in use at near-parity. There is
 * also a block of `:where([class~="rounded-lg"][class~="bg-surface"])` selectors
 * in globals.css whose only job is to bolt a shadow onto those duplicated
 * strings after the fact; this component is what lets that be deleted.
 *
 * No shadow. A card is separated from the page by its border and by the step
 * between `surface` and `canvas`, which is enough and does not accumulate into
 * the soft grey haze that made every screen look the same.
 */

export function Card({
  padding = 'md',
  interactive = false,
  as: Tag = 'div',
  className,
  children,
  ...rest
}: {
  padding?: 'none' | 'sm' | 'md';
  interactive?: boolean;
  as?: 'div' | 'section' | 'article';
  className?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, 'className' | 'children'>) {
  const pad = padding === 'none' ? '' : padding === 'sm' ? 'p-3' : 'p-5';
  return (
    <Tag
      className={cn(
        'rounded-md border border-line bg-surface',
        pad,
        interactive &&
          'transition-colors hover:bg-surface-hover cursor-pointer ' +
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
            'focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('flex items-start justify-between gap-3 mb-3', className)}>{children}</div>;
}

export function CardTitle({ className, children }: { className?: string; children: ReactNode }) {
  return <h3 className={cn('text-base font-semibold text-primary', className)}>{children}</h3>;
}

export function CardDescription({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn('text-sm text-secondary', className)}>{children}</p>;
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('text-sm text-secondary', className)}>{children}</div>;
}

export function CardFooter({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mt-4 flex items-center gap-2', className)}>{children}</div>;
}

/**
 * A row inside a card, divided by a hairline rather than being its own bordered
 * box. This replaces the card-inside-a-card pattern — lists where every item
 * carried its own border, background and radius, which is most of why the
 * dashboard read as a pile of boxes.
 *
 * Use `padding="none"` on the parent Card so rows reach its edges.
 */
export function CardRow({
  interactive = false,
  className,
  children,
  ...rest
}: {
  interactive?: boolean;
  className?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3 border-b border-subtle last:border-0',
        interactive && 'transition-colors hover:bg-surface-hover cursor-pointer',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
