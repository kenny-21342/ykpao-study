'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Lock, Sparkles, KeyRound, Loader2, CheckCircle2 } from 'lucide-react';

/**
 * Easter-egg unlock widget for the competition vault (STEP / AMC / AIME …).
 *
 * Deliberately tiny and low-contrast so it can't be found by casual scanning.
 * Sits in the footer of the practice workspace. Two unlock paths:
 *
 *   1. Konami code — the component listens for the ↑↑↓↓←→←→BA key sequence
 *      anywhere on the page and submits it automatically.
 *   2. A hidden passphrase input that only appears after clicking the dot.
 *      The phrase itself is set via COMPETITION_PASSPHRASE env var.
 *
 * On success the user's `unlocks` array gains "competition" (server-side) and
 * this component calls onUnlocked() so the parent can refresh.
 */
export default function UnlockWidget({ onUnlocked }: { onUnlocked: () => void }) {
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'idle' | 'ok' | 'fail'>('idle');
  const konamiBuffer = useRef<string[]>([]);

  const submit = useCallback(async (codeOrPassphrase: string) => {
    setBusy(true);
    setStatus('idle');
    try {
      const isKonami = codeOrPassphrase === 'konami';
      const body = isKonami ? { code: 'konami' } : { passphrase: codeOrPassphrase };
      const res = await fetch('/api/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (json?.unlocked) {
        setStatus('ok');
        setTimeout(() => {
          onUnlocked();
          setOpen(false);
        }, 900);
      } else {
        setStatus('fail');
      }
    } catch {
      setStatus('fail');
    } finally {
      setBusy(false);
    }
  }, [onUnlocked]);

  // Listen for the Konami sequence globally.
  useEffect(() => {
    const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
    const onKey = (e: KeyboardEvent) => {
      konamiBuffer.current.push(e.key === 'B' ? 'b' : e.key === 'A' ? 'a' : e.key);
      if (konamiBuffer.current.length > KONAMI.length) konamiBuffer.current.shift();
      if (konamiBuffer.current.join(',') === KONAMI.join(',')) {
        void submit('konami');
        konamiBuffer.current = [];
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit]);

  return (
    <>
      {/* The dot: ~10px, near-transparent, in the page corner. Easy to miss. */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Hidden content"
        tabIndex={-1}
        className="fixed bottom-1 right-2 w-2 h-2 rounded-full opacity-[0.08] hover:opacity-40 transition-opacity"
        style={{ background: 'currentColor' }}
      />

      {open && (
        <div className="fixed bottom-6 right-6 z-50 w-72 bg-white dark:bg-gray-800 rounded-lg shadow-2xl border border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-center gap-2 mb-3">
            <KeyRound className="w-4 h-4 text-gray-400" />
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Restricted area</span>
          </div>

          {status === 'ok' ? (
            <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 py-2">
              <CheckCircle2 className="w-4 h-4" /> Vault unlocked.
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
                Enter the passphrase to continue.
              </p>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && passphrase.trim()) submit(passphrase.trim()); }}
                placeholder="••••••••"
                className="w-full px-3 py-2 bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md text-sm text-gray-800 dark:text-gray-200"
                autoFocus
              />
              {status === 'fail' && (
                <p className="text-xs text-red-500 mt-2">Not recognised.</p>
              )}
              <button
                onClick={() => passphrase.trim() && submit(passphrase.trim())}
                disabled={busy || !passphrase.trim()}
                className="mt-3 w-full inline-flex items-center justify-center gap-1 py-2 text-sm font-semibold bg-gray-800 dark:bg-gray-200 text-white dark:text-gray-900 rounded-md disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
                Unlock
              </button>
              <p className="text-[10px] text-gray-400 mt-2 flex items-center gap-1">
                <Sparkles className="w-2.5 h-2.5" /> Or try the Konami code.
              </p>
            </>
          )}
        </div>
      )}
    </>
  );
}
