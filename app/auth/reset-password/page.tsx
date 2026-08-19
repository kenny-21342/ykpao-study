'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { GraduationCap, Lock, AlertCircle, CheckCircle2 } from 'lucide-react';

/** Shared chrome, so the fallback and the form cannot drift apart visually. */
function AuthPanel({ title, subtitle, children }: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
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

      <div className="relative ml-auto w-full sm:w-[440px] lg:w-[480px] min-h-screen bg-white flex flex-col justify-center px-8 sm:px-12 py-10 shadow-2xl">
        <div className="w-full">
          <div className="mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-green-500 to-emerald-600 rounded-2xl shadow-lg shadow-green-500/30 mb-4">
              <GraduationCap className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent mb-2">
              {title}
            </h1>
            <p className="text-gray-600">{subtitle}</p>
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
          <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start space-x-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700">
              Open the link from your email exactly as it was sent — some mail apps
              trim the end of long links.
            </p>
          </div>
          <Link
            href="/auth/forgot-password"
            className="block w-full py-3.5 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-xl font-semibold hover:shadow-lg hover:shadow-green-500/30 transition-all text-center"
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
          <div className="p-4 bg-green-50 border border-green-200 rounded-xl flex items-start space-x-3">
            <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-green-800">
              Your password has been changed. For your security, any other device
              still signed in to this account has been signed out.
            </p>
          </div>
          <Link
            href="/auth/login"
            className="block w-full py-3.5 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-xl font-semibold hover:shadow-lg hover:shadow-green-500/30 transition-all text-center"
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
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            New Password
          </label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full pl-11 pr-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent transition-all"
              placeholder="••••••••"
              required
              autoFocus
              minLength={8}
            />
          </div>
          <p className="mt-2 text-xs text-gray-500">At least 8 characters.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Confirm New Password
          </label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full pl-11 pr-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent transition-all"
              placeholder="••••••••"
              required
              minLength={8}
            />
          </div>
        </div>

        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start space-x-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-red-700">
              <p>{error}</p>
              <Link
                href="/auth/forgot-password"
                className="underline font-medium hover:text-red-800"
              >
                Request a new link
              </Link>
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3.5 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-xl font-semibold hover:shadow-lg hover:shadow-green-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Saving...' : 'Set New Password'}
        </button>
      </form>

      <div className="mt-6 text-center">
        <p className="text-sm text-gray-600">
          <Link
            href="/auth/login"
            className="text-green-600 font-semibold hover:text-green-700 transition-colors"
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
