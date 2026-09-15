'use client';

import { useEffect, useState } from 'react';
import { Download, X, Share, Plus } from 'lucide-react';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const DISMISS_KEY = 'pwa-install-dismissed';

/**
 * Registers the service worker and surfaces an install prompt when supported.
 * On iOS (which doesn't fire beforeinstallprompt) we show a one-time hint.
 *
 * Mounted once at the app root via app/layout.tsx so it is always available.
 */
export default function PWAInstall() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIOSHint, setShowIOSHint] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker
          .getRegistrations()
          .then((registrations) => {
            registrations.forEach((registration) => {
              registration.unregister().catch(() => {});
            });
          })
          .catch(() => {});
      }

      if ('caches' in window) {
        caches
          .keys()
          .then((keys) => {
            keys
              .filter((key) => key.startsWith('ykpao-'))
              .forEach((key) => {
                caches.delete(key).catch(() => {});
              });
          })
          .catch(() => {});
      }

      return;
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/', updateViaCache: 'none' })
        .catch(() => {
          // best-effort; offline support just won't be available.
        });
    }

    // Respect prior dismissal.
    Promise.resolve().then(() => {
      try {
        if (localStorage.getItem(DISMISS_KEY) === '1') setDismissed(true);
      } catch {
        // ignore
      }
    });

    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      // iOS Safari standalone flag.
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    if (isStandalone) return;

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as { MSStream?: unknown }).MSStream;
    if (isIOS) {
      Promise.resolve().then(() => setShowIOSHint(true));
      return;
    }

    const onBeforeInstall = (e: Event) => {
      e.preventDefault(); // don't show the browser's default prompt
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  }, []);

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
  };

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // ignore
    }
  };

  if (dismissed) return null;

  // Android/Chrome install prompt.
  if (deferred) {
    return (
      <div className="fixed bottom-4 right-4 z-50 max-w-xs bg-surface rounded-lg shadow-overlay border border-line p-4 animate-in slide-in-from-bottom">
        <button
          onClick={dismiss}
          className="absolute top-2 right-2 text-muted hover:text-secondary"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-accent flex items-center justify-center flex-shrink-0">
            <Download className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-primary">Install YKPao Study</p>
            <p className="text-xs text-muted mt-0.5">
              Add to your home screen for offline access to notes and review cards.
            </p>
            <button
              onClick={install}
              className="mt-2 w-full py-2 text-sm font-semibold bg-accent text-white rounded-md"
            >
              Install
            </button>
          </div>
        </div>
      </div>
    );
  }

  // iOS hint (no programmatic install, so just instructions).
  if (showIOSHint) {
    return (
      <div className="fixed bottom-4 right-4 z-50 max-w-xs bg-surface rounded-lg shadow-overlay border border-line p-4">
        <button
          onClick={dismiss}
          className="absolute top-2 right-2 text-muted hover:text-secondary"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-accent flex items-center justify-center flex-shrink-0">
            <Download className="w-5 h-5 text-white" />
          </div>
          <div>
            <p className="text-sm font-bold text-primary">Install YKPao Study</p>
            <p className="text-xs text-muted mt-1">
              Tap <Share className="inline w-3 h-3" /> then &ldquo;Add to Home Screen&rdquo;{' '}
              <Plus className="inline w-3 h-3" /> to study offline.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
