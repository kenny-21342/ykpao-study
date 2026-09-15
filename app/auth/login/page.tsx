'use client';

import { signIn, getProviders } from 'next-auth/react';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Field } from '@/app/components/ui';
import Image from 'next/image';
import { GraduationCap, Mail, Lock, AlertCircle, MailCheck } from 'lucide-react';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  // Shown instead of the error line: this is not a failure the student can fix
  // by retyping anything, so it gets its own message and its own action.
  const [unverified, setUnverified] = useState(false);
  const [loading, setLoading] = useState(false);
  // Which OAuth providers the server actually has credentials for. Rendering a
  // button for an unconfigured provider sends the student to a provider error
  // page they can't do anything about.
  const [oauthProviders, setOauthProviders] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    getProviders()
      .then((providers) => {
        if (cancelled || !providers) return;
        setOauthProviders(
          Object.values(providers)
            .filter((p) => p.type === 'oauth')
            .map((p) => p.id),
        );
      })
      .catch(() => {
        // Non-fatal: the email/password form still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setUnverified(false);

    try {
      const result = await signIn('credentials', {
        // Normalised so a stray capital or trailing space from autofill /
        // mobile keyboards doesn't read as a wrong password.
        email: email.trim().toLowerCase(),
        password,
        redirect: false,
        callbackUrl: `${window.location.origin}/`,
      });

      if (!result?.ok || result.error) {
        // `EmailUnverified` only ever comes back to someone who typed the
        // right password, so it is safe to be specific -- and necessary, since
        // "invalid email or password" would send them to reset a password that
        // is already correct.
        if (result?.error === 'EmailUnverified') {
          setUnverified(true);
          setError('');
        } else {
          setError(
            result?.error === 'RateLimited'
              ? 'Too many sign-in attempts. Please wait a minute and try again.'
              : 'Invalid email or password'
          );
        }
        setLoading(false);
        return;
      }

      window.location.assign('/');
    } catch {
      setError('Unable to sign in. Please try again.');
      setLoading(false);
    }
  };

  const handleGoogleSignIn = () => {
    void signIn('google', { callbackUrl: `${window.location.origin}/` });
  };

  return (
    <div className="min-h-screen w-full flex relative bg-black">
      {/* Full-bleed background image — covers the entire page.
          Served as WebP (160 KB, down from a 2.2 MB PNG) through next/image,
          which also emits the responsive srcset. This is the first paint every
          user sees, so its weight is the app's first impression. */}
      <Image
        src="/auth-hero.webp"
        alt=""
        fill
        priority
        sizes="100vw"
        className="fixed inset-0 object-cover"
      />

      {/* Right-edge rectangular form panel.
          On mobile it stacks below the image (panel takes full width); on
          lg+ it pins to the right side as a solid column. */}
      <div className="relative ml-auto w-full sm:w-[440px] lg:w-[480px] min-h-screen bg-surface flex flex-col justify-center px-8 sm:px-12 py-10">
        <div className="w-full">

          {/* Logo Section */}
          <div className="mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-accent rounded-lg mb-4">
              <GraduationCap className="w-8 h-8 text-accent-fg" />
            </div>
            <h1 className="text-3xl font-bold text-primary mb-2">
              Welcome Back
            </h1>
            <p className="text-secondary">Sign in to continue your learning journey</p>
          </div>

          {/* Login Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            <Field label="Email address" required>
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
                  />
                </div>
              )}
            </Field>

            <Field label="Password" required>
              {({ id }) => (
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted" />
                  <input
                    id={id}
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full pl-11 pr-4 py-3 rounded-lg border border-strong bg-surface text-primary placeholder:text-muted transition-colors focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring/25"
                    placeholder="••••••••"
                    autoComplete="current-password"
                    required
                  />
                </div>
              )}
            </Field>

            <div className="-mt-2 text-right">
              <Link
                href="/auth/forgot-password"
                className="text-sm font-medium text-accent-text transition-colors hover:text-accent"
              >
                Forgot password?
              </Link>
            </div>

            {error && (
              <div className="p-4 bg-danger-subtle border border-danger-border rounded-lg flex items-start space-x-3">
                <AlertCircle className="w-5 h-5 text-danger flex-shrink-0 mt-0.5" />
                <p className="text-sm text-danger">{error}</p>
              </div>
            )}

            {unverified && (
              <div className="p-4 bg-warning-subtle border border-warning-border rounded-lg flex items-start space-x-3">
                <MailCheck className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                <div className="text-sm text-warning">
                  <p className="font-medium">Confirm your email to continue</p>
                  <p className="mt-1">
                    We sent a link to <span className="font-medium">{email.trim().toLowerCase()}</span>.
                    Open it to finish setting up your account &mdash; check your spam folder if it
                    is not there.
                  </p>
                  <Link
                    href={`/auth/verify?email=${encodeURIComponent(email.trim().toLowerCase())}`}
                    className="inline-block mt-2 font-semibold text-warning underline underline-offset-2"
                  >
                    Send another link
                  </Link>
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 bg-accent text-accent-fg rounded-lg font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          {oauthProviders.includes('google') && (
          <div className="mt-6">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-line"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-4 bg-surface text-muted">Or continue with</span>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              <button
                type="button"
                onClick={handleGoogleSignIn}
                className="w-full py-3 border-2 border-line rounded-lg font-medium hover:bg-surface-hover transition-all flex items-center justify-center gap-3 group"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                <span className="text-secondary group-hover:text-primary">Continue with Google</span>
              </button>
            </div>
          </div>
          )}

          <div className="mt-6 text-center">
            <p className="text-sm text-secondary">
              Don&apos;t have an account?{' '}
              <Link href="/auth/signup" className="text-accent-text font-semibold hover:text-accent-text transition-colors">
                Sign Up
              </Link>
            </p>
          </div>

          {/* Footer */}
          <div className="mt-8 text-center text-xs text-muted">
            <p>By signing in, you agree to our Terms of Service and Privacy Policy</p>
          </div>
        </div>
      </div>
    </div>
  );
}
