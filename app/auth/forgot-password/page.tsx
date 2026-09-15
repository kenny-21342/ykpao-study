'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Field } from '@/app/components/ui';
import Image from 'next/image';
import { GraduationCap, Mail, AlertCircle, MailCheck } from 'lucide-react';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        setError(data?.error ?? 'Something went wrong. Please try again.');
        setLoading(false);
        return;
      }

      // The server answers identically for an address that exists and one that
      // does not, so the UI must not imply it knows which this was.
      setSent(true);
      setLoading(false);
    } catch {
      setError('Unable to send the reset link. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex relative bg-black">
      <Image
        src="/auth-hero.webp"
        alt=""
        fill
        priority
        sizes="100vw"
        className="fixed inset-0 object-cover"
      />

      <div className="relative ml-auto w-full sm:w-[440px] lg:w-[480px] min-h-screen bg-surface flex flex-col justify-center px-8 sm:px-12 py-10">
        <div className="w-full">
          <div className="mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-accent rounded-lg mb-4">
              <GraduationCap className="w-8 h-8 text-accent-fg" />
            </div>
            <h1 className="text-3xl font-bold text-primary mb-2">
              Forgot Password
            </h1>
            <p className="text-secondary">
              {sent
                ? 'Check your inbox for the next step'
                : "Enter your email and we'll send you a reset link"}
            </p>
          </div>

          {sent ? (
            <div className="space-y-5">
              <div className="p-4 bg-accent-subtle border border-accent-border rounded-lg flex items-start space-x-3">
                <MailCheck className="w-5 h-5 text-accent-text flex-shrink-0 mt-0.5" />
                <p className="text-sm text-accent-text">
                  If that email belongs to an account, a password reset link is on its
                  way. It expires in 60 minutes and can only be used once. Remember to
                  check your spam folder.
                </p>
              </div>
              <Link
                href="/auth/login"
                className="block w-full py-3.5 bg-accent text-accent-fg rounded-lg font-semibold transition-all text-center"
              >
                Back to Sign In
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <Field label="Email Address" required>
                {({ id }) => (
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted" />
                    <input
                      id={id}
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full pl-11 pr-4 py-3 rounded-lg border border-strong bg-surface text-primary placeholder:text-muted transition-colors focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring/25"
                      placeholder="student@example.com"
                      autoComplete="email"
                      required
                      autoFocus
                    />
                  </div>
                )}
              </Field>

              {error && (
                <div className="p-4 bg-danger-subtle border border-danger-border rounded-lg flex items-start space-x-3">
                  <AlertCircle className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-danger">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3.5 bg-accent text-accent-fg rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Sending...' : 'Send Reset Link'}
              </button>
            </form>
          )}

          <div className="mt-6 text-center">
            <p className="text-sm text-secondary">
              Remembered it?{' '}
              <Link
                href="/auth/login"
                className="text-accent-text font-semibold hover:text-accent-text transition-colors"
              >
                Sign In
              </Link>
            </p>
          </div>

          <div className="mt-8 text-center text-xs text-muted">
            <p>
              Signing in with Google? That account has no password — use the Google
              button on the sign-in page.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
