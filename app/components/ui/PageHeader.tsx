import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { cn } from './cn';

/**
 * The top of a screen: a title, optional supporting line, optional actions.
 *
 * Not a card. Page titles were previously bolded `text-sm` inside a bordered
 * box, which is how a screen ends up with no clear starting point — the title
 * looked like everything else on it.
 *
 * `back` absorbs the ad-hoc "← Back" links that each chrome-less route grew its
 * own version of.
 */
export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  back,
  className,
}: {
  title: string;
  eyebrow?: string;
  description?: string;
  actions?: ReactNode;
  back?: { href: string; label: string };
  className?: string;
}) {
  return (
    <header className={cn('mb-6', className)}>
      {back && (
        <Link
          href={back.href}
          className="inline-flex items-center gap-1.5 mb-3 text-sm text-secondary hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          {back.label}
        </Link>
      )}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          {eyebrow && (
            <p className="text-xs font-medium uppercase tracking-wide text-muted mb-1">{eyebrow}</p>
          )}
          <h1 className="text-xl font-semibold tracking-tight text-primary">{title}</h1>
          {description && <p className="mt-1 text-sm text-secondary max-w-2xl">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </header>
  );
}
