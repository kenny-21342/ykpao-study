'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import {
  GraduationCap,
  Mail,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';

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

type Status = 'idle' | 'checking' | 'done' | 'failed';

function VerifyView() {
  // Next 16 client-side-renders the tree up to the nearest Suspense boundary
  // when this hook is used, hence the wrapper in the default export.
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const [status, setStatus] = useState<Status>(token ? 'checking' : 'idle');
  const [error, setError] = useState('');

  // Resend form, shown when there is no token or the token failed.
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [sending, setSending] = useState(false);
  const [sentMessage, setSentMessage] = useState('');

  // React 19 runs effects twice in development. The token is single-use, so a
  // second POST would redeem nothing and flip a successful confirmation into
  // "invalid or expired" -- the classic double-mount bug, and one that looks
  // like a broken link rather than a broken guard.
  const redeemed = useRef(false);

  useEffect(() => {
    if (!token || redeemed.current) return;
    redeemed.current = true;

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok) {
          setStatus('done');
        } else {
          setError(data?.error ?? 'This confirmation link did not work.');
          setStatus('failed');
        }
      } catch {
        if (cancelled) return;
        setError('We could not reach the server. Please try again in a moment.');
        setStatus('failed');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleResend = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    setSentMessage('');
    setError('');
    try {
      const res = await fetch('/api/auth/verify/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setSentMessage(data?.message ?? 'Check your inbox.');
      } else {
        setError(data?.error ?? 'Something went wrong. Please try again.');
      }
    } catch {
      setError('We could not reach the server. Please try again in a moment.');
    } finally {
      setSending(false);
    }
  };

  if (status === 'checking') {
    return (
      <AuthPanel title="Confirming" subtitle="One moment while we check your link.">
        <div className="flex items-center space-x-3 text-gray-600">
          <Loader2 className="w-5 h-5 animate-spin text-green-600" />
          <span className="text-sm">Confirming your email address&hellip;</span>
        </div>
      </AuthPanel>
    );
  }

  if (status === 'done') {
    return (
      <AuthPanel title="Email confirmed" subtitle="Your account is ready to use.">
        <div className="p-4 bg-green-50 border border-green-200 rounded-xl flex items-start space-x-3 mb-6">
          <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-green-800">
            Thanks &mdash; that address is confirmed. You can sign in now.
          </p>
        </div>
        <Link
          href="/auth/login"
          className="block w-full text-center py-3 px-4 rounded-xl font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-600 shadow-lg shadow-green-500/30 hover:from-green-600 hover:to-emerald-700 transition"
        >
          Go to sign in
        </Link>
      </AuthPanel>
    );
  }

  // 'idle' (arrived without a token) and 'failed' share one screen: both need
  // the same thing next, which is a working link.
  return (
    <AuthPanel
      title="Confirm your email"
      subtitle={
        status === 'failed'
          ? 'That link did not work. Send yourself a new one.'
          : 'Enter your address and we will send you a new link.'
      }
    >
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start space-x-3 mb-6">
          <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {sentMessage ? (
        <div className="p-4 bg-green-50 border border-green-200 rounded-xl flex items-start space-x-3">
          <CheckCircle2 className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-green-800">{sentMessage}</p>
        </div>
      ) : (
        <form onSubmit={handleResend} className="space-y-5">
          <div>
            <label htmlFor="verify-email" className="block text-sm font-medium text-gray-700 mb-2">
              Email address
            </label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
              <input
                id="verify-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full pl-11 pr-4 py-3 rounded-xl border border-gray-300 focus:border-green-500 focus:ring-2 focus:ring-green-500/20 outline-none transition"
                placeholder="you@example.com"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={sending}
            className="w-full py-3 px-4 rounded-xl font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-600 shadow-lg shadow-green-500/30 hover:from-green-600 hover:to-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed transition"
          >
            {sending ? 'Sending…' : 'Send a new link'}
          </button>
        </form>
      )}

      <p className="mt-6 text-sm text-gray-600">
        <Link href="/auth/login" className="font-medium text-green-600 hover:text-green-700">
          Back to sign in
        </Link>
      </p>
    </AuthPanel>
  );
}

export default function VerifyPage() {
  return (
    <Suspense
      fallback={<AuthPanel title="Confirm your email" subtitle="Loading&hellip;">{null}</AuthPanel>}
    >
      <VerifyView />
    </Suspense>
  );
}
