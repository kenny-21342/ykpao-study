'use client';

/**
 * The guided walkthrough shown once, after onboarding.
 *
 * It spotlights real elements in the shell rather than describing them in a
 * modal: each step finds its `data-tour` anchor, cuts a hole in the dimming
 * overlay around it and puts a card beside it. Steps whose anchor is not on
 * the page are dropped before the tour starts (Practice and Mock exams are
 * behind feature flags), so it can never point at nothing.
 *
 * Completion is recorded server-side through `POST /api/onboarding`
 * (`tourCompleted: true`), not in localStorage: a student who signs in on the
 * school desktop and again on their laptop should not be toured twice.
 * Dismissing counts as completing -- being shown it again after saying no is
 * the behaviour that makes people distrust the close button.
 */

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';

import { TOUR_STEPS, cardPosition, visibleSteps, type TourStep } from '@/lib/product-tour';

const CARD = { width: 320, height: 190 };

type Rect = { top: number; left: number; width: number; height: number };

function anchorRect(anchor: string): Rect | null {
  if (typeof document === 'undefined') return null;
  const element = document.querySelector(`[data-tour="${anchor}"]`);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

export default function ProductTour({ onFinish }: { onFinish: () => void }) {
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  // Resolved after mount: the anchors belong to the shell around this
  // component, so they do not exist during the first render pass.
  useLayoutEffect(() => {
    // Reading the DOM is the external system this effect exists to synchronise
    // with, which is the case the rule cannot distinguish: the anchors belong
    // to the shell and there is no render-time value to derive this from.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSteps(visibleSteps(TOUR_STEPS, (anchor) => anchorRect(anchor) !== null));
  }, []);

  const step = steps?.[index];

  useLayoutEffect(() => {
    if (!step) return;
    const measure = () => setRect(anchorRect(step.anchor));
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step]);

  const finish = useCallback(() => {
    // Fire-and-forget: the tour closes immediately either way, and a failed
    // stamp costs one repeat rather than a stuck overlay.
    void fetch('/api/onboarding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tourCompleted: true }),
    }).catch(() => undefined);
    onFinish();
  }, [onFinish]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [finish]);

  // Nothing to point at -- a narrow screen with the sidebar closed, say. Stamp
  // it done rather than leaving a student to meet the overlay on every load.
  useEffect(() => {
    if (steps && steps.length === 0) finish();
  }, [steps, finish]);

  if (!steps || steps.length === 0 || !step || !rect) return null;

  const isLast = index === steps.length - 1;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const card = cardPosition(rect, CARD, viewport, step.placement);
  const pad = 6;

  return (
    <div className="fixed inset-0 z-[120]" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {/* The dim is four panels around the anchor rather than one box with a
        * cut-out: a `box-shadow` spotlight renders differently across browsers
        * and cannot be given a border that survives dark mode.
        *
        * They deliberately do NOT dismiss on click. Click-outside-to-close is
        * right for a modal the user opened, and wrong for a seven-step tour
        * whose card moves to a different place on every step: a click aimed at
        * Next that lands a few pixels wide ends the tour for good, and it is
        * shown once per account. Escape and the two explicit controls are the
        * ways out. */}
      <div className="absolute inset-x-0 top-0 bg-black/50" style={{ height: Math.max(0, rect.top - pad) }} />
      <div className="absolute inset-x-0 bg-black/50" style={{ top: rect.top + rect.height + pad, bottom: 0 }} />
      <div className="absolute bg-black/50" style={{ top: Math.max(0, rect.top - pad), height: rect.height + pad * 2, left: 0, width: Math.max(0, rect.left - pad) }} />
      <div className="absolute bg-black/50" style={{ top: Math.max(0, rect.top - pad), height: rect.height + pad * 2, left: rect.left + rect.width + pad, right: 0 }} />

      <div
        className="pointer-events-none absolute rounded-lg ring-2 ring-accent"
        style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }}
      />

      <div
        className="absolute w-[320px] rounded-lg border border-line bg-surface p-4 shadow-overlay"
        style={{ top: card.top, left: card.left }}
      >
        <div className="flex items-start justify-between gap-2">
          <h2 id="tour-title" className="text-sm font-bold text-primary">{step.title}</h2>
          <button onClick={finish} title="Skip the tour" aria-label="Skip the tour" className="rounded-sm p-1 text-muted hover:bg-surface-hover">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-2 text-xs leading-5 text-secondary">{step.body}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-[10px] font-medium text-muted">{index + 1} of {steps.length}</span>
          <div className="flex items-center gap-2">
            {index > 0 && (
              <button onClick={() => setIndex((value) => value - 1)} className="h-8 rounded-md border border-strong px-3 text-xs font-semibold text-secondary">
                Back
              </button>
            )}
            <button
              onClick={() => (isLast ? finish() : setIndex((value) => value + 1))}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-semibold text-white"
            >
              {isLast ? 'Finish' : 'Next'}
              {!isLast && <ArrowRight className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
