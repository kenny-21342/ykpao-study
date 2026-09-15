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
      className={`flex items-start gap-3 rounded-lg border border-warning-border bg-warning-subtle px-4 py-3 text-warning ${className}`}
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-warning" />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-semibold">{readiness.title}</p>
        <p className="text-sm leading-relaxed text-warning">{readiness.body}</p>
      </div>
    </div>
  );
}
