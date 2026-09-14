'use client';

import { AlertTriangle } from 'lucide-react';
import { featureReadiness, type PreviewFeature } from '@/lib/feature-readiness';

/**
 * The "this feature is not finished" banner. Deliberately not dismissible:
 * the whole point is that someone who lands here from a dashboard nudge, a
 * study-plan link or the sidebar sees the same warning every time.
 */
export default function PreviewNotice({
  feature,
  className = '',
}: {
  feature: PreviewFeature;
  className?: string;
}) {
  const readiness = featureReadiness(feature);
  if (readiness.state !== 'preview') return null;

  return (
    <div
      role="status"
      className={`flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100 ${className}`}
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-semibold">{readiness.title}</p>
        <p className="text-sm leading-relaxed text-amber-800 dark:text-amber-200/90">{readiness.body}</p>
      </div>
    </div>
  );
}
