'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { signIn, getProviders } from 'next-auth/react';
import { GraduationCap, Mail, Lock, User as UserIcon, AlertCircle, CheckCircle, MailCheck } from 'lucide-react';

// Kept in sync with the zod schema in app/api/auth/signup/route.ts.
const MIN_PASSWORD_LENGTH = 8;

/** Rough strength estimate: length plus character-class variety. */
function scorePassword(password: string): 'weak' | 'medium' | 'strong' {
  if (password.length < MIN_PASSWORD_LENGTH) return 'weak';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) =>
    re.test(password),
  ).length;
  if (password.length >= 12 && classes >= 3) return 'strong';
  if (password.length >= 10 || classes >= 3) return 'medium';
  return 'weak';
}

export default function SignupPage() {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [error, setError] = useState('');
  // Set when the address is already registered, so we can offer a way onward
  // instead of leaving the student staring at a dead end.
  const [emailTaken, setEmailTaken] = useState(false);
  // Set once the account exists. The form is replaced by a "check your inbox"
  // panel rather than redirecting: there is nowhere useful to send them until
  // the address is confirmed.
  const [created, setCreated] = useState<{ email: string; emailSent: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  // Which fields the student has finished with, so inline errors appear on
  // blur rather than only after a failed submit.
  const [touched, setTouched] = useState({ password: false, confirmPassword: false });
  // Only offer OAuth the server can actually complete — see the login page.
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
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const passwordProblem =
    formData.password.length > 0 && formData.password.length < MIN_PASSWORD_LENGTH
      ? `Use at least ${MIN_PASSWORD_LENGTH} characters`
      : null;
  const confirmProblem =
    formData.confirmPassword.length > 0 && formData.password !== formData.confirmPassword
      ? 'Passwords do not match'
      : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setEmailTaken(false);
    setTouched({ password: true, confirmPassword: true });

    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      setLoading(false);
      return;
    }

    if (formData.password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      setLoading(false);
      return;
    }

    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          email: formData.email,
          password: formData.password,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        // 409 is the "already registered" case; offer a route to sign in.
        if (res.status === 409) setEmailTaken(true);
        setError(data.error || 'Something went wrong');
        setLoading(false);
        return;
      }

      // No auto sign-in any more: the account starts unconfirmed and the
      // credentials provider refuses it a session until the emailed link is
      // clicked. Attempting it here would fail every single time and read to
      // the student as a broken signup rather than a step they still owe.
      setCreated({ email: formData.email.trim().toLowerCase(), emailSent: data.emailSent !== false });
      setLoading(false);
    } catch {
      setError('Failed to create account');
      setLoading(false);
    }
  };

  const handleGoogleSignIn = () => {
    void signIn('google', { callbackUrl: `${window.location.origin}/` });
  };

  const passwordStrength = scorePassword(formData.password);

  // The account exists but cannot be signed into yet. This replaces the form
  // entirely rather than sitting above it -- resubmitting would only produce
  // the 409 "already registered" error, which reads as a failure.
  if (created) {
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
                <MailCheck className="w-8 h-8 text-white" />
              </div>
              <h1 className="text-3xl font-bold bg-gradient-to-r from-green-500 to-emerald-600 bg-clip-text text-transparent mb-2">
                Check your inbox
              </h1>
              <p className="text-gray-600">One last step before you can sign in.</p>
            </div>

            {created.emailSent ? (
              <div className="p-4 bg-green-50 border border-green-200 rounded-xl text-sm text-green-800 mb-6">
                We sent a confirmation link to{' '}
                <span className="font-semibold">{created.email}</span>. Open it to activate your
                account. The link lasts 24 hours &mdash; check your spam folder if it has not
                arrived in a few minutes.
              </div>
            ) : (
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800 mb-6">
                Your account was created, but we could not send the confirmation email just now.
                Request a new link below, or contact us if it keeps failing.
              </div>
            )}

            <Link
              href={`/auth/verify?email=${encodeURIComponent(created.email)}`}
              className="block w-full text-center py-3 px-4 rounded-xl font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-600 shadow-lg shadow-green-500/30 hover:from-green-600 hover:to-emerald-700 transition"
            >
              Send another link
            </Link>

            <p className="mt-6 text-sm text-gray-600">
              Already confirmed?{' '}
              <Link href="/auth/login" className="font-medium text-green-600 hover:text-green-700">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

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

      {/* Right-edge rectangular form panel. */}
      <div className="relative ml-auto w-full sm:w-[440px] lg:w-[480px] min-h-screen bg-white flex flex-col justify-center px-8 sm:px-12 py-10 shadow-2xl">
        <div className="w-full">

          {/* Logo Section */}
          <div className="mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-green-500 to-emerald-600 rounded-2xl shadow-lg shadow-green-500/30 mb-4">
              <GraduationCap className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-3xl font-bold bg-gradient-to-r from-green-500 to-emerald-600 bg-clip-text text-transparent mb-2">
              Create Account
            </h1>
            <p className="text-gray-600">Start your learning journey today</p>
          </div>

          {/* Signup Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Full Name
              </label>
              <div className="relative">
                <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full pl-11 pr-4 py-3 border border-gray-300 rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent transition-all"
                  placeholder="e.g. Alex Chen"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
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
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  onBlur={() => setTouched((t) => ({ ...t, password: true }))}
                  aria-describedby="password-rules"
                  aria-invalid={touched.password && Boolean(passwordProblem)}
                  className={`w-full pl-11 pr-4 py-3 border rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent transition-all ${
                    touched.password && passwordProblem ? 'border-red-400' : 'border-gray-300'
                  }`}
                  placeholder="••••••••"
                  required
                />
              </div>
              {/* State the rule up front instead of only rejecting after submit. */}
              <p id="password-rules" className="mt-2 text-xs text-gray-500">
                At least {MIN_PASSWORD_LENGTH} characters. Mixing letters, numbers,
                and symbols makes it stronger.
              </p>
              {touched.password && passwordProblem && (
                <p className="mt-1 text-xs text-red-600">{passwordProblem}</p>
              )}
              {formData.password && (
                <div className="mt-2">
                  <div className="flex items-center gap-1">
                    <div className={`h-1 flex-1 rounded-full ${passwordStrength === 'weak' ? 'bg-red-400' : passwordStrength === 'medium' ? 'bg-yellow-400' : 'bg-green-400'}`} />
                    <div className={`h-1 flex-1 rounded-full ${passwordStrength === 'medium' || passwordStrength === 'strong' ? passwordStrength === 'medium' ? 'bg-yellow-400' : 'bg-green-400' : 'bg-gray-200'}`} />
                    <div className={`h-1 flex-1 rounded-full ${passwordStrength === 'strong' ? 'bg-green-400' : 'bg-gray-200'}`} />
                  </div>
                  <p className="mt-1 text-xs text-gray-500 capitalize">{passwordStrength} password</p>
                </div>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Confirm Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="password"
                  value={formData.confirmPassword}
                  onChange={(e) => setFormData({ ...formData, confirmPassword: e.target.value })}
                  onBlur={() => setTouched((t) => ({ ...t, confirmPassword: true }))}
                  aria-invalid={touched.confirmPassword && Boolean(confirmProblem)}
                  className={`w-full pl-11 pr-4 py-3 border rounded-xl focus:ring-2 focus:ring-green-500 focus:border-transparent transition-all ${
                    touched.confirmPassword && confirmProblem ? 'border-red-400' : 'border-gray-300'
                  }`}
                  placeholder="••••••••"
                  required
                />
                {formData.confirmPassword && formData.password === formData.confirmPassword && (
                  <CheckCircle className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-green-500" />
                )}
              </div>
              {touched.confirmPassword && confirmProblem && (
                <p className="mt-1 text-xs text-red-600">{confirmProblem}</p>
              )}
            </div>

            {error && (
              <div className="p-4 bg-red-50 border border-red-200 rounded-xl flex items-start space-x-3">
                <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div className="text-sm text-red-700">
                  <p>{error}</p>
                  {emailTaken && (
                    <Link
                      href="/auth/login"
                      className="mt-1 inline-block font-semibold text-red-800 underline hover:text-red-900"
                    >
                      Sign in instead
                    </Link>
                  )}
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-xl font-semibold hover:shadow-lg hover:shadow-green-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Creating account...' : 'Create Account'}
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
              Already have an account?{' '}
              <Link href="/auth/login" className="text-green-600 font-semibold hover:text-green-700 transition-colors">
                Sign In
              </Link>
            </p>
          </div>

          {/* Footer */}
          <div className="mt-8 text-center text-xs text-gray-500">
            <p>By creating an account, you agree to our Terms of Service and Privacy Policy</p>
          </div>
        </div>
      </div>
    </div>
  );
}
