'use client';

/**
 * Lets a student choose which model answers them in the tutor, and shows which
 * ones can answer at all.
 *
 * The shared key points at a gateway carrying twenty models from eight
 * vendors, and availability is not incidental to it: thirteen were down when
 * this was written, and which thirteen changes through the day. A picker that
 * listed all twenty as equals would send students at models that cannot reply.
 * So the list is live, read from the gateway operator's public status page via
 * `/api/ai/models`, and a model that is down is shown as down and cannot be
 * selected.
 *
 * Only rendered on the shared key. A student using their own key picked their
 * own model when they saved it, and it is never substituted.
 *
 * The choice is kept in `localStorage`: it is a per-device preference, the
 * server re-resolves it against live availability on every request anyway, and
 * a stale or withdrawn value costs nothing because the server falls back on
 * its own. That also means it needs no migration and cannot fail in a way that
 * blocks a message being sent.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

import type { SharedModelChoice } from '@/lib/shared-models';

const STORAGE_KEY = 'tutor-model';

/** Read the saved choice, or null. Validation is the server's job, not this. */
export function readSavedTutorModel(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private browsing, or storage blocked. No preference is a valid state.
    return null;
  }
}

export default function TutorModelPicker({
  models,
  model,
  onChange,
}: {
  models: SharedModelChoice[];
  model: string | null;
  onChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // What the server would pick, mirrored here so the label does not claim a
  // model that is down. Same order as `resolveSharedModel`: the choice if it
  // is up, otherwise anything that is.
  const chosen = models.find((entry) => entry.id === model);
  const effective = chosen?.up ? chosen : models.find((entry) => entry.up) ?? chosen ?? null;

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

  if (models.length === 0) return null;

  const vendors = [...new Set(models.map((entry) => entry.vendor))];
  const upCount = models.filter((entry) => entry.up).length;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex max-w-full items-center gap-1 rounded-sm text-[11px] text-accent-text hover:text-white"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`AI model: ${effective?.label ?? 'none available'}. Choose a different model`}
      >
        <span className="truncate">{effective?.label ?? 'No model available'}</span>
        <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="AI model"
          className="absolute left-0 top-full z-50 mt-1 max-h-80 w-72 overflow-y-auto rounded-lg border border-line bg-surface text-primary shadow-overlay"
        >
          <p className="sticky top-0 border-b border-line bg-surface px-3 py-2 text-[11px] text-secondary">
            {upCount} of {models.length} answering now. The rest are temporarily
            unavailable — the tutor picks one that works if yours is out.
          </p>
          {vendors.map((vendor) => (
            <div key={vendor}>
              <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-secondary">
                {vendor}
              </p>
              {models
                .filter((entry) => entry.vendor === vendor)
                .map((entry) => {
                  const isSelected = entry.id === model;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isSelected}
                      disabled={!entry.up}
                      onClick={() => choose(entry.id)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                    >
                      <Check
                        className={`h-3.5 w-3.5 shrink-0 ${isSelected ? 'text-accent' : 'opacity-0'}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                      {!entry.up && (
                        <span className="shrink-0 text-[10px] text-secondary">unavailable</span>
                      )}
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
