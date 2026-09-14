import { cn } from './cn';

/**
 * One figure, borderless.
 *
 * The dashboard previously gave each of four equivalent numbers its own
 * bordered card and its own accent colour — blue, green, amber, purple — in a
 * tinted rounded icon square. Four colours for four things that mean the same
 * kind of thing is decoration, and it accounted for four of the eleven-odd
 * boxes a student met on first load. These sit in a row divided by hairlines.
 *
 * Figures are tabular so columns of marks line up; IBM Plex has real tabular
 * figures but does not use them by default.
 */

export function StatTile({
  label,
  value,
  hint,
  delta,
  className,
}: {
  label: string;
  value: string;
  hint?: string;
  delta?: { value: string; direction: 'up' | 'down' | 'flat' };
  className?: string;
}) {
  return (
    <div className={cn('px-4 py-3 first:pl-0 last:pr-0 min-w-0', className)}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted truncate">{label}</p>
      <p className="mt-1 text-xl font-semibold text-primary tabular-nums">{value}</p>
      {(delta || hint) && (
        <p className="mt-0.5 text-xs truncate">
          {delta && (
            // Only a fall is coloured. A rise does not need to announce itself,
            // and colouring both turns the row back into a traffic light.
            <span className={delta.direction === 'down' ? 'text-danger' : 'text-muted'}>
              {delta.value}
            </span>
          )}
          {delta && hint && <span className="text-muted"> · </span>}
          {hint && <span className="text-muted">{hint}</span>}
        </p>
      )}
    </div>
  );
}

export function StatRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap divide-x divide-subtle -mx-4', className)}>{children}</div>
  );
}
