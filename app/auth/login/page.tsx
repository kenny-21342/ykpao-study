'use client';

import { signIn, getProviders } from 'next-auth/react';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { GraduationCap, Mail, Lock, AlertCircle } from 'lucide-react';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
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
        setError('Invalid email or password');
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
      <div className="relative ml-auto w-full sm:w-[440px] lg:w-[480px] min-h-screen bg-white flex flex-col justify-center px-8 sm:px-12 py-10 shadow-2xl">
        <div className="w-full">

          {/* Logo Section */}
          <div className="mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-green-500 to-emerald-600 rounded-2xl shadow-lg shadow-green-500/30 mb-4">
              <GraduationCap className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent mb-2">
              Welcome Back
            </h1>
            <p className="text-gray-600">Sign in to continue your learning journey</p>
          </div>

          {/* Login Form */}
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
                  className="w-full pl-11 pr-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent transition-all"
                  placeholder="student@example.com"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Password
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
                />
              </div>
            </div>

            <div className="-mt-2 text-right">
              <Link
                href="/auth/forgot-password"
                className="text-sm text-green-600 font-medium hover:text-green-700 transition-colors"
              >
                Forgot password?
              </Link>
            </div>

            {error && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start space-x-3">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-xl font-semibold hover:shadow-lg hover:shadow-green-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          {oauthProviders.includes('google') && (
          <div className="mt-6">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-200"></div>
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-4 bg-white text-gray-500">Or continue with</span>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              <button
                type="button"
                onClick={handleGoogleSignIn}
                className="w-full py-3 border-2 border-gray-200 rounded-xl font-medium hover:bg-gray-50 transition-all flex items-center justify-center gap-3 group"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                <span className="text-gray-700 group-hover:text-gray-900">Continue with Google</span>
              </button>
            </div>
          </div>
          )}

          <div className="mt-6 text-center">
            <p className="text-sm text-gray-600">
              Don&apos;t have an account?{' '}
              <Link href="/auth/signup" className="text-green-600 font-semibold hover:text-green-700 transition-colors">
                Sign Up
              </Link>
            </p>
          </div>

          {/* Footer */}
          <div className="mt-8 text-center text-xs text-gray-500">
            <p>By signing in, you agree to our Terms of Service and Privacy Policy</p>
          </div>
        </div>
      </div>
    </div>
  );
}
