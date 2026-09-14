'use client';

import { useRef } from 'react';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from './cn';

/**
 * A row of mutually exclusive choices.
 *
 * Four screens hand-rolled this (StudyCoach, QuestionsDatabase, MockExams,
 * ResourceLibrary), each with its own idea of what "selected" looks like —
 * usually a filled accent gradient. Here the selection is a raised surface
 * against an inset track, which is quieter and does not spend the accent on
 * something that is not an action.
 *
 * Keyboard handling is real: arrow keys move between options with a roving
 * tabindex, so only the selected option is in the tab order. These are not
 * tab panels in most of their uses, so this is a radiogroup rather than a
 * tablist.
 */

export interface SegmentedItem<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  badge?: ReactNode;
}

export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  size = 'md',
  ariaLabel,
  className,
}: {
  items: SegmentedItem<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  ariaLabel: string;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (from: number, delta: number) => {
    const next = (from + delta + items.length) % items.length;
    onChange(items[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-md border border-line bg-surface-raised p-0.5',
        className,
      )}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        const Icon = item.icon;
        return (
          <button
            key={item.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                move(index, -1);
              }
            }}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors whitespace-nowrap',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-sm',
              selected
                ? 'bg-surface text-primary'
                : 'text-secondary hover:text-primary hover:bg-surface-hover',
            )}
          >
            {Icon && <Icon className={size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'} aria-hidden="true" />}
            {item.label}
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}
