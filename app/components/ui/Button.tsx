import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

/**
 * The one button.
 *
 * No gradients and no shadows — 76 of the app's 96 gradients were the same
 * green-to-emerald pair on buttons like this one, and an adjacent-hue gradient
 * adds sheen rather than information. A filled accent says "primary" on its
 * own.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-active border border-transparent',
  secondary: 'bg-surface text-primary border border-line hover:bg-surface-hover',
  ghost: 'bg-transparent text-secondary border border-transparent hover:bg-surface-hover hover:text-primary',
  danger: 'bg-danger text-inverse border border-transparent hover:opacity-90',
  link: 'bg-transparent text-accent-text border border-transparent underline-offset-4 hover:underline px-0',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-md',
};

const BASE =
  'inline-flex items-center justify-center font-medium whitespace-nowrap ' +
  'transition-colors select-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ' +
  'disabled:opacity-50 disabled:pointer-events-none';

export function buttonClasses(options?: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
}): string {
  const { variant = 'secondary', size = 'md', fullWidth, className } = options ?? {};
  return cn(BASE, VARIANTS[variant], SIZES[size], fullWidth && 'w-full', className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconPosition?: 'start' | 'end';
  loading?: boolean;
  fullWidth?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  iconPosition = 'start',
  loading = false,
  fullWidth = false,
  className,
  children,
  disabled,
  type,
  ...rest
}: ButtonProps) {
  const iconSize = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4';
  const glyph = loading ? (
    <Loader2 className={cn(iconSize, 'motion-safe:animate-spin')} aria-hidden="true" />
  ) : Icon ? (
    <Icon className={iconSize} aria-hidden="true" />
  ) : null;

  return (
    <button
      // Defaulting to "button" rather than the HTML default of "submit": a
      // button inside a form that silently submits it is the single most
      // common bug this component can prevent.
      type={type ?? 'button'}
      disabled={disabled || loading}
      className={buttonClasses({ variant, size, fullWidth, className })}
      // `rest` is spread last so aria-label, aria-pressed and the rest reach
      // the DOM. tests/dialogs.test.ts requires every icon-only control to
      // carry an accessible name.
      {...rest}
    >
      {glyph && iconPosition === 'start' && glyph}
      {children}
      {glyph && iconPosition === 'end' && glyph}
    </button>
  );
}
