'use client';

import { useEffect } from 'react';

/**
 * Last-resort boundary for errors thrown by the root layout itself.
 *
 * This replaces the root layout when active, so it must supply its own
 * <html>/<body> — and it cannot rely on globals.css or the Geist fonts being
 * loaded, which is why the styling here is inline and deliberately minimal.
 * It only renders when the app is too broken for `app/error.tsx` to run.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error('Root layout error:', error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem',
          backgroundColor: '#f8fafc',
          color: '#0f172a',
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <title>Something went wrong — YKPao Study</title>
        <div
          style={{
            width: '100%',
            maxWidth: '28rem',
            textAlign: 'center',
            border: '1px solid #e2e8f0',
            borderRadius: '1rem',
            background: '#ffffff',
            padding: '2rem',
          }}
        >
          <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.25rem' }}>
            Something went wrong
          </h1>
          <p
            style={{
              margin: '0 0 1.5rem',
              fontSize: '0.875rem',
              lineHeight: 1.6,
              color: '#475569',
            }}
          >
            YKPao Study failed to start. Please try again — if this keeps
            happening, let your teacher know.
          </p>
          <button
            onClick={() => unstable_retry()}
            style={{
              minHeight: '2.75rem',
              padding: '0 1.25rem',
              border: 'none',
              borderRadius: '0.75rem',
              background: '#1A7F4B',
              color: '#ffffff',
              fontSize: '0.875rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          {error.digest && (
            <p style={{ marginTop: '1.5rem', fontSize: '0.6875rem', color: '#94a3b8' }}>
              Reference: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
