'use client';

/**
 * Lets a student choose which free model answers them in the tutor.
 *
 * Two reasons it exists, and the second is the one that matters more:
 *
 *  1. Every model on the shared key is promotional and time-limited. When one
 *     is withdrawn the provider answers with an unknown-model error, and
 *     without a picker the tutor is simply broken for everyone until someone
 *     redeploys. With one, a student can move on themselves.
 *  2. /privacy has to tell students that what they send the tutor may be used
 *     to train the model. Saying so and offering nothing to do about it, short
 *     of obtaining their own API key, is a warning rather than a choice. Two of
 *     these models keep a zero-retention policy, and this is where that becomes
 *     actionable — hence the badge.
 *
 * Only rendered on the shared key. A student using their own key picked their
 * own model when they saved it, and it is never substituted.
 *
 * The choice is kept in `localStorage`, deliberately rather than in the
 * database: it is a per-device preference, the server validates it on every
 * request regardless, and a missing or withdrawn value costs nothing because
 * the server falls back to the configured default. That also means it needs no
 * migration and cannot fail in a way that blocks a message being sent.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ShieldCheck } from 'lucide-react';

import { SHARED_MODEL_CHOICES, isSharedModelChoice } from '@/lib/shared-models';

const STORAGE_KEY = 'tutor-model';

/**
 * Read the saved choice, or null.
 *
 * Validated on the way out as well as on the server: a model saved last term
 * and withdrawn since is the expected case, not an exotic one, and it must
 * resolve to the default rather than to a broken request.
 */
export function readSavedTutorModel(): string | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isSharedModelChoice(saved) ? saved : null;
  } catch {
    // Private browsing, or storage blocked. No preference is a valid state.
    return null;
  }
}

export default function TutorModelPicker({
  model,
  onChange,
}: {
  model: string | null;
  onChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected =
    SHARED_MODEL_CHOICES.find((choice) => choice.id === model) ?? SHARED_MODEL_CHOICES[0];

  // Close on an outside click or Escape. Not a modal: it is a menu inside a
  // panel that is itself dismissible, so it does not take the focus trap the
  // shared dialog uses.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const choose = (id: string) => {
    setOpen(false);
    onChange(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // The choice still applies to this session; only persistence is lost.
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex max-w-full items-center gap-1 rounded-sm text-[11px] text-accent-text hover:text-white"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`AI model: ${selected.label}. Choose a different model`}
      >
        <span className="truncate">{selected.label}</span>
        {selected.retention === 'zero' && <ShieldCheck className="h-3 w-3 shrink-0" aria-hidden="true" />}
        <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="AI model"
          className="absolute left-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-lg border border-line bg-surface text-primary shadow-overlay"
        >
          <p className="border-b border-line px-3 py-2 text-[11px] text-secondary">
            All of these are free to use. The shield marks the ones that keep nothing you
            send and never train on it.
          </p>
          {SHARED_MODEL_CHOICES.map((choice) => {
            const isSelected = choice.id === selected.id;
            return (
              <button
                key={choice.id}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => choose(choice.id)}
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-surface-hover"
              >
                <Check
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${isSelected ? 'text-accent' : 'opacity-0'}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-xs font-medium">
                    {choice.label}
                    {choice.retention === 'zero' && (
                      <ShieldCheck className="h-3 w-3 shrink-0 text-accent" aria-hidden="true" />
                    )}
                  </span>
                  <span className="block text-[11px] text-secondary">{choice.note}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
