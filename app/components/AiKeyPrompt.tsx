'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Sparkles, X } from 'lucide-react';

/**
 * Tells a student their AI features are off *before* they lose an answer to it.
 *
 * Nothing in the app ever pointed at the AI key. The only way to find out one
 * was needed was to write an answer, submit it, and read the notice attached to
 * the empty grade that came back -- so the first time marking mattered was also
 * the first time anyone mentioned it. For an account that arrives through
 * self-signup, with no administrator setting anything up for them, that is the
 * default experience rather than an edge case.
 *
 * Dismissal is per-browser (`localStorage`), deliberately: this is a nudge, not
 * a setting, and it is not worth a column or a round trip. It comes back on a
 * new device, which is the right failure -- and it stops appearing for good the
 * moment a key actually works, because the check below is the live one.
 */

const DISMISSED_KEY = 'ai-key-prompt-dismissed';

export default function AiKeyPrompt() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Read before fetching, so a dismissed card costs nothing.
    try {
      if (localStorage.getItem(DISMISSED_KEY) === '1') return;
    } catch {
      // Private browsing or blocked storage: fall through and show it.
    }

    fetch('/api/account/ai-credentials')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        // `{ credentials: { ... } }`, not the bare view. Reading
        // `data.textEnabled` here gave `undefined`, which is not `=== false`,
        // so this card never appeared for anybody -- and because the check is
        // deliberately conservative (see the catch below), it failed closed
        // and silently. `AiProviderPanel` unwraps the same envelope correctly;
        // this was the only consumer that did not.
        const credentials = data?.credentials;
        // Only when AI is genuinely unavailable. A student on an
        // administrator's shared key needs no prompt -- theirs already works.
        if (!cancelled && credentials && credentials.textEnabled === false) setShow(true);
      })
      .catch(() => {
        // A failed check is not evidence the key is missing; say nothing.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Dismissed for this view either way.
    }
  };

  return (
    <div className="relative mb-6 rounded-lg border border-warning-border bg-warning-subtle p-4 sm:p-5">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss this message"
        className="absolute top-3 right-3 p-1 rounded-md text-warning hover:text-warning hover:bg-warning-subtle transition"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="flex items-start gap-3 pr-8">
        <span className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-warning-subtle flex-shrink-0">
          <Sparkles className="w-5 h-5 text-warning" />
        </span>
        <div className="min-w-0">
          <h3 className="font-semibold text-warning">
            Turn on AI marking
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-warning">
            Written answers are marked against the mark scheme, hints are generated as you
            work, and mock papers are graded question by question — but all of it needs an
            AI key, and your account does not have one yet. Add your own, or ask an
            administrator for shared access.
          </p>
          <p className="mt-3 flex flex-wrap items-center gap-4 text-sm">
            <Link
              href="/account"
              className="font-semibold text-warning underline underline-offset-2"
            >
              Add an API key
            </Link>
            <button
              type="button"
              onClick={dismiss}
              className="text-warning hover:text-warning"
            >
              Not now
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
