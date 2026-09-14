'use client';

import { useState } from 'react';
import Link from 'next/link';
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

      <div className="relative ml-auto w-full sm:w-[440px] lg:w-[480px] min-h-screen bg-white flex flex-col justify-center px-8 sm:px-12 py-10 shadow-2xl">
        <div className="w-full">
          <div className="mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-accent rounded-lg shadow-lg mb-4">
              <GraduationCap className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-3xl font-bold text-primary mb-2">
              Forgot Password
            </h1>
            <p className="text-gray-600">
              {sent
                ? 'Check your inbox for the next step'
                : "Enter your email and we'll send you a reset link"}
            </p>
          </div>

          {sent ? (
            <div className="space-y-5">
              <div className="p-4 bg-green-50 border border-green-200 rounded-lg flex items-start space-x-3">
                <MailCheck className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-green-800">
                  If that email belongs to an account, a password reset link is on its
                  way. It expires in 60 minutes and can only be used once. Remember to
                  check your spam folder.
                </p>
              </div>
              <Link
                href="/auth/login"
                className="block w-full py-3.5 bg-accent text-white rounded-lg font-semibold hover:shadow-lg transition-all text-center"
              >
                Back to Sign In
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Email Address
                </label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full pl-11 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent transition-all"
                    placeholder="student@example.com"
                    required
                    autoFocus
                  />
                </div>
              </div>

              {error && (
                <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start space-x-3">
                  <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-700">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3.5 bg-accent text-white rounded-lg font-semibold hover:shadow-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? 'Sending...' : 'Send Reset Link'}
              </button>
            </form>
          )}

          <div className="mt-6 text-center">
            <p className="text-sm text-gray-600">
              Remembered it?{' '}
              <Link
                href="/auth/login"
                className="text-green-600 font-semibold hover:text-green-700 transition-colors"
              >
                Sign In
              </Link>
            </p>
          </div>

          <div className="mt-8 text-center text-xs text-gray-500">
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
