'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Field } from '@/app/components/ui';
import { GraduationCap, Lock, AlertCircle, CheckCircle2 } from 'lucide-react';

/** Shared chrome, so the fallback and the form cannot drift apart visually. */
function AuthPanel({ title, subtitle, children }: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen w-full flex relative bg-canvas">

      <div className="relative mx-auto w-full sm:w-[440px] lg:w-[480px] min-h-screen bg-surface flex flex-col justify-center px-8 sm:px-12 py-10">
        <div className="w-full">
          <div className="mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-accent rounded-lg mb-4">
              <GraduationCap className="w-8 h-8 text-accent-fg" />
            </div>
            <h1 className="text-3xl font-bold text-primary mb-2">
              {title}
            </h1>
            <p className="text-secondary">{subtitle}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

function ResetPasswordForm() {
  // Next 16 client-side-renders the tree up to the nearest Suspense boundary
  // when this hook is used, hence the wrapper in the default export.
  const token = useSearchParams().get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Checked here purely to save a round trip; the server enforces the same
    // minimum, and is the only check that counts.
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.error ?? 'Something went wrong. Please try again.');
        setLoading(false);
        return;
      }

      setDone(true);
      setLoading(false);
    } catch {
      setError('Unable to reset your password. Please try again.');
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <AuthPanel
        title="Reset Password"
        subtitle="This link is missing its reset code"
      >
        <div className="space-y-5">
          <div className="p-4 bg-danger-subtle border border-danger-border rounded-lg flex items-start space-x-3">
            <AlertCircle className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" />
            <p className="text-sm text-danger">
              Open the link from your email exactly as it was sent — some mail apps
              trim the end of long links.
            </p>
          </div>
          <Link
            href="/auth/forgot-password"
            className="block w-full py-3.5 bg-accent text-accent-fg rounded-lg font-semibold transition-all text-center"
          >
            Request a New Link
          </Link>
        </div>
      </AuthPanel>
    );
  }

  if (done) {
    return (
      <AuthPanel title="Password Changed" subtitle="You can now sign in">
        <div className="space-y-5">
          <div className="p-4 bg-accent-subtle border border-accent-border rounded-lg flex items-start space-x-3">
            <CheckCircle2 className="w-5 h-5 text-accent-text flex-shrink-0 mt-0.5" />
            <p className="text-sm text-accent-text">
              Your password has been changed. For your security, any other device
              still signed in to this account has been signed out.
            </p>
          </div>
          <Link
            href="/auth/login"
            className="block w-full py-3.5 bg-accent text-accent-fg rounded-lg font-semibold transition-all text-center"
          >
            Go to Sign In
          </Link>
        </div>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel title="Reset Password" subtitle="Choose a new password for your account">
      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="New Password" required>
          {({ id }) => (
            <>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted" />
                <input
                  id={id}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 rounded-lg border border-strong bg-surface text-primary placeholder:text-muted transition-colors focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring/25"
                  placeholder="••••••••"
                  autoComplete="new-password"
                  required
                  autoFocus
                  minLength={8}
                />
              </div>
              <p className="mt-2 text-xs text-muted">At least 8 characters.</p>
            </>
          )}
        </Field>

        <Field label="Confirm New Password" required>
          {({ id }) => (
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted" />
              <input
                id={id}
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full pl-11 pr-4 py-3 rounded-lg border border-strong bg-surface text-primary placeholder:text-muted transition-colors focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring/25"
                placeholder="••••••••"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </div>
          )}
        </Field>

        {error && (
          <div className="p-4 bg-danger-subtle border border-danger-border rounded-lg flex items-start space-x-3">
            <AlertCircle className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" />
            <div className="text-sm text-danger">
              <p>{error}</p>
              <Link
                href="/auth/forgot-password"
                className="underline font-medium hover:text-danger"
              >
                Request a new link
              </Link>
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3.5 bg-accent text-accent-fg rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Saving...' : 'Set New Password'}
        </button>
      </form>

      <div className="mt-6 text-center">
        <p className="text-sm text-secondary">
          <Link
            href="/auth/login"
            className="text-accent-text font-semibold hover:text-accent-text transition-colors"
          >
            Back to Sign In
          </Link>
        </p>
      </div>
    </AuthPanel>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={<AuthPanel title="Reset Password" subtitle="Loading your reset link..." >{null}</AuthPanel>}
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
