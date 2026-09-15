'use client';

import { useState, useRef, useEffect } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft, User as UserIcon, Lock, Check, Loader2, AlertCircle, Mail,
  Camera, Image as ImageIcon, Trash2,
} from 'lucide-react';
import CoursesGoalsPanel from './CoursesGoalsPanel';
import AiProviderPanel from './AiProviderPanel';

export default function AccountSettingsPage() {
  const { data: session, status, update } = useSession();
  const router = useRouter();
  const [name, setName] = useState(session?.user?.name ?? '');
  const [savingName, setSavingName] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  /**
   * Whether /api/account has answered yet.
   *
   * Without this the form rendered blank and fully editable while the profile
   * was still in flight, and Save wrote whatever was in it -- so a student who
   * clicked Save quickly, or whose request failed (the catch below swallowed
   * every error), replaced their real name with an empty string. The fields
   * are disabled until the real values are in.
   */
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);

  // Avatar + background image
  const [avatarUrl, setAvatarUrl] = useState(session?.user?.image ?? '');
  const [bgUrl, setBgUrl] = useState('');
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [uploadingBg, setUploadingBg] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const bgInputRef = useRef<HTMLInputElement>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPwd, setSavingPwd] = useState(false);
  const [pwdSaved, setPwdSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reported explicitly by /api/account. Assume true until told otherwise so
  // the password panel doesn't flash "unavailable" during the initial load.
  const [hasPassword, setHasPassword] = useState(true);

  // Load persisted profile fields instead of relying on the session snapshot,
  // which does not include the app background and may be initially empty.
  useEffect(() => {
    if (status !== 'authenticated') return;
    let cancelled = false;
    fetch('/api/account')
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not load your profile.');
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        if (!data?.user) throw new Error('Could not load your profile.');
        setName(data.user.name ?? '');
        setAvatarUrl(data.user.image ?? '');
        setBgUrl(data.user.bgImage ?? '');
        setHasPassword(Boolean(data.user.hasPassword));
        setProfileLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        // Stays loading on purpose: the fields keep their disabled state, so
        // a failure cannot be saved over the real profile.
        setProfileError(
          'We could not load your profile. Reload the page before changing anything — saving now could overwrite what is stored.',
        );
      });
    return () => { cancelled = true; };
  }, [status]);

  // Navigating during render is a React side-effect violation (and warns in
  // dev); do it after commit instead.
  useEffect(() => {
    if (status === 'unauthenticated') router.push('/auth/login');
  }, [status, router]);

  if (status === 'loading' || status === 'unauthenticated') {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  const handleSaveName = async () => {
    // Belt and braces: the button is disabled while loading, but this is the
    // write that could destroy a real name, so it refuses outright.
    if (profileLoading) return;
    setSavingName(true);
    setError(null);
    try {
      const res = await fetch('/api/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await update({ name });
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSavingName(false);
    }
  };

  const uploadAndSaveImage = async (
    file: File,
    kind: 'avatar' | 'bg',
  ) => {
    if (file.size > 25 * 1024 * 1024) {
      setError('Image too large (max 25 MB).');
      return;
    }
    const setUploader = kind === 'avatar' ? setUploadingAvatar : setUploadingBg;
    setUploader(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const upRes = await fetch('/api/upload', { method: 'POST', body: fd });
      const upData = await upRes.json();
      if (!upRes.ok || !upData.fileUrl) throw new Error(upData.error || 'Upload failed');

      const field = kind === 'avatar' ? 'image' : 'bgImage';
      const res = await fetch('/api/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: upData.fileUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (kind === 'avatar') {
        setAvatarUrl(upData.fileUrl);
        await update({ image: upData.fileUrl });
      } else {
        setBgUrl(upData.fileUrl);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to upload');
    } finally {
      setUploader(false);
    }
  };

  const removeImage = async (kind: 'avatar' | 'bg') => {
    const field = kind === 'avatar' ? 'image' : 'bgImage';
    setError(null);
    try {
      const res = await fetch('/api/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: '' }),
      });
      if (!res.ok) throw new Error('Failed to remove');
      if (kind === 'avatar') {
        setAvatarUrl('');
        await update({ image: '' });
      } else {
        setBgUrl('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove');
    }
  };

  const handleChangePassword = async () => {
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    setSavingPwd(true);
    try {
      const res = await fetch('/api/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPwdSaved(true);
      // Changing the password invalidates every session issued against the old
      // one — including this tab's. That is the point (a stolen session must
      // not survive a password change), but it means staying here would leave
      // the user clicking around a page that is quietly no longer signed in.
      // So end the session deliberately and send them back to sign in.
      setTimeout(() => {
        void signOut({ callbackUrl: '/auth/login' });
      }, 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change password');
    } finally {
      setSavingPwd(false);
    }
  };

  const isOAuth = !hasPassword;

  return (
    <div className="min-h-screen bg-canvas p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Account Settings</h1>
        </div>

        {error && (
          <div className="bg-red-50/80 dark:bg-red-900/20 backdrop-blur-xl border border-red-200 dark:border-red-800 rounded-lg p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
          </div>
        )}

        {/* Profile section */}
        <div className="bg-white/70 dark:bg-gray-800/60 backdrop-blur-xl border border-white/40 dark:border-gray-700/50 rounded-lg p-6 space-y-4">
          <div className="flex items-center gap-2">
            <UserIcon className="w-5 h-5 text-green-600" />
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Profile</h2>
          </div>

          {/* Avatar picker */}
          <div className="flex items-center gap-4">
            <div className="relative">
              <div className="w-20 h-20 rounded-lg bg-accent flex items-center justify-center text-white font-bold text-2xl overflow-hidden">
                {avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
                ) : (
                  (session?.user?.name?.[0] ?? 'U').toUpperCase()
                )}
              </div>
              <button
                onClick={() => avatarInputRef.current?.click()}
                disabled={uploadingAvatar}
                className="absolute -bottom-1 -right-1 w-8 h-8 bg-white dark:bg-gray-700 border-2 border-green-500 rounded-full flex items-center justify-center text-green-600 hover:scale-110 transition-transform disabled:opacity-50"
                title="Upload avatar" aria-label="Upload avatar"
              >
                {uploadingAvatar ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
              </button>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadAndSaveImage(f, 'avatar'); }}
                className="hidden"
              />
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Avatar</p>
              <p className="text-xs text-gray-400 mt-0.5">PNG, JPG, or WEBP. Shown next to your name across the app.</p>
              {avatarUrl && (
                <button onClick={() => removeImage('avatar')} className="mt-1.5 inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700">
                  <Trash2 className="w-3 h-3" /> Remove avatar
                </button>
              )}
            </div>
          </div>

          {/* Background image picker */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">App background (optional)</label>
            <div className="flex items-center gap-3">
              <button
                onClick={() => bgInputRef.current?.click()}
                disabled={uploadingBg}
                className="flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                {uploadingBg ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />}
                {uploadingBg ? 'Uploading…' : bgUrl ? 'Change background' : 'Upload background'}
              </button>
              <input
                ref={bgInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadAndSaveImage(f, 'bg'); }}
                className="hidden"
              />
              {bgUrl && (
                <>
                  <div
                    className="h-10 w-16 overflow-hidden rounded-md border border-gray-200 bg-cover bg-center dark:border-gray-600"
                    style={{ backgroundImage: `url(${JSON.stringify(bgUrl)})` }}
                    aria-label="Current app background preview"
                    role="img"
                  />
                  <button onClick={() => removeImage('bg')} className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700">
                    <Trash2 className="w-3 h-3" /> Remove
                  </button>
                </>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-1">Displayed behind the translucent app shell. Wide landscape images work best.</p>
          </div>

          <div className="border-t border-gray-100 dark:border-gray-700 pt-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Display name</label>
            <div className="relative">
              <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={name}
                disabled={profileLoading}
                onChange={(e) => setName(e.target.value)}
                placeholder={profileLoading ? 'Loading…' : undefined}
                className="w-full pl-10 pr-4 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none disabled:opacity-60 disabled:cursor-not-allowed"
              />
            </div>
            {profileError && (
              <p className="mt-2 text-xs text-red-600 dark:text-red-400">{profileError}</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Email</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="email"
                value={session?.user?.email ?? ''}
                disabled
                className="w-full pl-10 pr-4 py-2.5 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg text-sm text-gray-500"
              />
            </div>
            <p className="text-xs text-gray-400 mt-1">Email cannot be changed.</p>
          </div>

          <button
            onClick={handleSaveName}
            disabled={profileLoading || savingName || name === (session?.user?.name ?? '')}
            className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {savingName ? <Loader2 className="w-4 h-4 animate-spin" /> : nameSaved ? <Check className="w-4 h-4" /> : null}
            {savingName ? 'Saving…' : nameSaved ? 'Saved!' : 'Save Name'}
          </button>
        </div>

        <CoursesGoalsPanel />

        <AiProviderPanel />

        {/* Password section */}
        <div className="bg-white/70 dark:bg-gray-800/60 backdrop-blur-xl border border-white/40 dark:border-gray-700/50 rounded-lg p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Lock className="w-5 h-5 text-green-600" />
            <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">Change Password</h2>
          </div>

          {isOAuth ? (
            <p className="text-sm text-gray-400">
              You signed in with a social account (Google). Password management is not available.
            </p>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Current password</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                  placeholder="••••••••"
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">New password</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                    placeholder="••••••••"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Confirm new password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:ring-2 focus:ring-green-500 outline-none"
                    placeholder="••••••••"
                  />
                </div>
              </div>
              <button
                onClick={handleChangePassword}
                disabled={savingPwd || !newPassword || !currentPassword}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-accent rounded-lg shadow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingPwd ? <Loader2 className="w-4 h-4 animate-spin" /> : pwdSaved ? <Check className="w-4 h-4" /> : null}
                {savingPwd ? 'Updating…' : pwdSaved ? 'Password changed — signing you out…' : 'Change Password'}
              </button>
            </>
          )}
        </div>

        {/* Quick links */}
        <div className="flex items-center gap-3">
          <Link
            href="/usage"
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
          >
            Usage & API Credits →
          </Link>
        </div>
      </div>
    </div>
  );
}
