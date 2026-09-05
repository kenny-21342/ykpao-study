'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Check, Eye, Loader2, Plug, Save, Sparkles, Trash2, XCircle } from 'lucide-react';

/**
 * Bring-your-own-key settings.
 *
 * The platform no longer pays for AI usage, so this panel is what turns AI on
 * for an account. Two rules shape it:
 *
 *  - The key is write-only. The server returns a four-character hint and
 *    nothing else, so there is no "reveal" affordance here — only replace and
 *    delete.
 *  - Text and vision are separate capabilities. A student who names only a
 *    text model has a working account with handwriting OCR switched off, and
 *    is told exactly that rather than being left to discover it.
 *
 * The "Test my key" button makes one minimal completion against the student's
 * OWN key — never the shared platform key, or a broken key would appear to
 * pass for anyone holding an admin grant. It tests the text model only.
 */

type TestResult = { ok: boolean; message: string; model?: string | null };

/**
 * Providers a student can realistically sign up to, with the two fields they
 * would otherwise have to find in someone's API documentation.
 *
 * Testers read "API endpoint" and "Text model" as questions they had no way to
 * answer -- the panel explained what a key is for and then asked for two
 * values it never offered. Picking a provider fills both; "Something else"
 * restores the blank fields for a school proxy or a provider not listed.
 *
 * Model names are the cheap general-purpose one at each provider, not the
 * flagship: this is marking and hinting, and the student pays the bill.
 */
const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    textModel: 'deepseek-chat',
    visionModel: '',
    note: 'Cheapest for marking and hints. No handwriting OCR.',
    keysUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    textModel: 'deepseek-ai/DeepSeek-V3',
    visionModel: 'Qwen/Qwen3-VL-32B-Instruct',
    note: 'Reachable from the mainland, and does handwriting OCR.',
    keysUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    textModel: 'deepseek/deepseek-chat',
    visionModel: 'qwen/qwen-2.5-vl-72b-instruct',
    note: 'One key, many models. Needs a VPN in the mainland.',
    keysUrl: 'https://openrouter.ai/keys',
  },
] as const;

type Credentials = {
  hasOwnKey: boolean;
  keyHint: string | null;
  baseUrl: string | null;
  textModel: string | null;
  visionModel: string | null;
  sharedKeyAccess: boolean;
  source: 'user' | 'shared' | null;
  textEnabled: boolean;
  visionEnabled: boolean;
  encryptionConfigured: boolean;
  keyUndecryptable: boolean;
  visionNotice: string | null;
};

export default function AiProviderPanel() {
  const [state, setState] = useState<Credentials | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const [provider, setProvider] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [textModel, setTextModel] = useState('');
  const [visionModel, setVisionModel] = useState('');

  const apply = (credentials: Credentials) => {
    setState(credentials);
    // A result describes the key that was tested; once the saved settings
    // change it is no longer about anything on screen.
    setTestResult(null);
    setBaseUrl(credentials.baseUrl ?? '');
    setTextModel(credentials.textModel ?? '');
    setVisionModel(credentials.visionModel ?? '');
    setApiKey('');
  };

  useEffect(() => {
    let cancelled = false;
    fetch('/api/account/ai-credentials')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data?.credentials) return;
        apply(data.credentials);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/account/ai-credentials', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Omitted entirely when left blank, so an edit to the model name
          // does not require re-pasting the key.
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          baseUrl,
          textModel,
          visionModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save');
      apply(data.credentials);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/account/ai-credentials', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not remove');
      apply(data.credentials);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove');
    } finally {
      setSaving(false);
    }
  };

  /**
   * One cheap probe of the saved credential. The route refuses to fall back to
   * the platform key, so a failure here really is this student's key.
   */
  const testKey = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const res = await fetch('/api/account/ai-credentials/test', { method: 'POST' });
      const data = await res.json();
      setTestResult({
        ok: Boolean(data.ok),
        message: data.message || data.error || (res.ok ? 'Your key works.' : 'The test failed.'),
        model: data.model ?? null,
      });
    } catch {
      setTestResult({ ok: false, message: 'Could not reach the server to run the test.' });
    } finally {
      setTesting(false);
    }
  };

  const canSave = Boolean(baseUrl.trim() && textModel.trim() && (apiKey.trim() || state?.hasOwnKey));

  /**
   * Fill the endpoint and models from a preset.
   *
   * The key field is deliberately untouched: switching provider does not
   * invalidate a key the student already saved, and clearing it here would
   * look like the key had been deleted when it had not.
   */
  const choose = (id: string) => {
    const preset = PROVIDERS.find((candidate) => candidate.id === id);
    setProvider(id);
    if (!preset) return;
    setBaseUrl(preset.baseUrl);
    setTextModel(preset.textModel);
    setVisionModel(preset.visionModel);
  };

  const chosen = PROVIDERS.find((candidate) => candidate.id === provider) ?? null;

  return (
    <section className="bg-white/70 dark:bg-gray-800/60 backdrop-blur-xl border border-white/40 dark:border-gray-700/50 shadow-xl rounded-2xl p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles className="w-5 h-5 text-green-600" />
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">AI Provider</h2>
      </div>

      <div className="space-y-2 text-xs text-gray-500 dark:text-gray-400">
        <p>
          <span className="font-semibold text-gray-700 dark:text-gray-300">
            Everything except AI already works without this.
          </span>{' '}
          Past papers, the question bank, notes, mock exam papers and your study plan need no key
          at all. Setting one up additionally turns on marking, hints, tutoring and reading your
          handwriting.
        </p>
        <p>
          Those run on your own account with an AI provider, billed by them — this platform does
          not pay for them, which is why it cannot just switch them on for you. Your key is
          encrypted before it is stored and is never shown again after you save it.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          {error && (
            <div className="bg-red-50/80 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
            </div>
          )}

          {state && !state.encryptionConfigured && (
            <div className="bg-amber-50/80 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-3 text-sm text-amber-800 dark:text-amber-200">
              This server is not yet configured to store API keys securely
              (<code>CREDENTIAL_ENCRYPTION_KEY</code> is missing). Saving is disabled until an
              administrator sets it.
            </div>
          )}

          {state?.keyUndecryptable && (
            <div className="bg-amber-50/80 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-3 text-sm text-amber-800 dark:text-amber-200">
              Your saved key can no longer be read, because the server’s encryption key changed.
              Paste your API key again below to restore AI features.
            </div>
          )}

          {/* Current state, in one line the student can act on. */}
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/40 p-3 space-y-1.5">
            <p className="text-sm font-medium text-gray-800 dark:text-gray-200">
              {state?.textEnabled
                ? state.source === 'shared'
                  ? 'AI is on, using a shared key an administrator granted you.'
                  : 'AI is on, using your key.'
                : 'AI is currently switched off for your account.'}
            </p>
            {state?.hasOwnKey && (
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Stored key: <span className="font-mono">{state.keyHint ?? '••••'}</span>
              </p>
            )}
            <p className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1.5">
              <Eye className="w-3 h-3" />
              Handwriting OCR (photos of your working):{' '}
              {state?.visionEnabled ? 'available' : 'unavailable'}
            </p>
            {state?.visionNotice && (
              <p className="text-xs leading-5 text-amber-700 dark:text-amber-300">{state.visionNotice}</p>
            )}
          </div>

          {/* Step 1: pick a provider, which fills the two fields nobody can
              guess. Skippable -- "Something else" leaves them blank. */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Who is providing the AI?
            </label>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {PROVIDERS.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => choose(candidate.id)}
                  aria-pressed={provider === candidate.id}
                  className={`rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition-colors ${
                    provider === candidate.id
                      ? 'border-green-500 bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-200'
                      : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-green-400'
                  }`}
                >
                  {candidate.name}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setProvider('other')}
                aria-pressed={provider === 'other'}
                className={`rounded-xl border px-3 py-2.5 text-left text-sm font-semibold transition-colors ${
                  provider === 'other'
                    ? 'border-green-500 bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-200'
                    : 'border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:border-green-400'
                }`}
              >
                Something else
              </button>
            </div>
            {chosen && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                {chosen.note}{' '}
                <a
                  href={chosen.keysUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-medium text-green-700 dark:text-green-400 underline underline-offset-2"
                >
                  Get a key from {chosen.name}
                </a>
                , then paste it below. The endpoint and models are filled in for you.
              </p>
            )}
            {provider === 'other' && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                Any OpenAI-compatible endpoint works, including a school proxy. Fill in the
                endpoint and model name your provider documents.
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              API key
            </label>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={state?.hasOwnKey ? 'Leave blank to keep your saved key' : 'sk-…'}
              className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none"
            />
            <p className="text-xs text-gray-400 mt-1">
              Stored encrypted. It can be replaced or deleted, but never displayed again.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              API endpoint
            </label>
            <input
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.deepseek.com/v1"
              className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none"
            />
            <p className="text-xs text-gray-400 mt-1">
              The base URL of an OpenAI-compatible API. Must be https. <code>/chat/completions</code>{' '}
              is added for you if you leave it off.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                Text model
              </label>
              <input
                type="text"
                value={textModel}
                onChange={(e) => setTextModel(e.target.value)}
                placeholder="deepseek-chat"
                className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none"
              />
              <p className="text-xs text-gray-400 mt-1">
                Tutoring, hints, grading, mock exams.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                Vision model (optional)
              </label>
              <input
                type="text"
                value={visionModel}
                onChange={(e) => setVisionModel(e.target.value)}
                placeholder="Qwen/Qwen3-VL-32B-Instruct"
                className="w-full px-4 py-2.5 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded-xl text-sm focus:ring-2 focus:ring-green-500 outline-none"
              />
              <p className="text-xs text-gray-400 mt-1">
                Needed only to photograph handwritten work. Leave blank and everything else still
                works.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={save}
              disabled={saving || !canSave || !state?.encryptionConfigured}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-green-500 to-emerald-500 rounded-xl shadow hover:shadow-md transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : saved ? (
                <Check className="w-4 h-4" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              {saving ? 'Saving…' : saved ? 'Saved!' : 'Save AI settings'}
            </button>
            {/* Enabled only when a key of this student's own is stored — the
                test deliberately has nothing to fall back on. */}
            <button
              onClick={testKey}
              disabled={testing || saving || !state?.hasOwnKey}
              title={state?.hasOwnKey ? undefined : 'Save your own API key first'}
              className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-gray-700 dark:text-gray-200 bg-white/70 dark:bg-gray-900/60 border border-gray-300 dark:border-gray-600 rounded-xl hover:bg-white dark:hover:bg-gray-900 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
              {testing ? 'Testing…' : 'Test my key'}
            </button>
            {state?.hasOwnKey && (
              <button
                onClick={remove}
                disabled={saving || testing}
                className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
              >
                <Trash2 className="w-3 h-3" /> Remove my key
              </button>
            )}
          </div>

          {testResult && (
            <div
              role="status"
              className={`rounded-xl border p-3 flex items-start gap-2 ${
                testResult.ok
                  ? 'bg-green-50/80 dark:bg-green-900/20 border-green-200 dark:border-green-800'
                  : 'bg-red-50/80 dark:bg-red-900/20 border-red-200 dark:border-red-800'
              }`}
            >
              {testResult.ok ? (
                <Check className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
              ) : (
                <XCircle className="w-4 h-4 text-red-600 flex-shrink-0 mt-0.5" />
              )}
              <div className="space-y-1">
                <p
                  className={`text-sm ${
                    testResult.ok
                      ? 'text-green-800 dark:text-green-200'
                      : 'text-red-700 dark:text-red-300'
                  }`}
                >
                  {testResult.message}
                </p>
                {/* Said every time, pass or fail: a green tick above covers the
                    text model only. Checking the vision model would mean
                    uploading a real image and paying for a real OCR call. */}
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  This tested your text model{testResult.model ? ` (${testResult.model})` : ''} only.
                  {visionModel.trim()
                    ? ` Your vision model (${visionModel.trim()}) was not tested — handwriting OCR needs a real image, so it is only exercised the first time you photograph your working.`
                    : ' You have no vision model set, so handwriting OCR stays unavailable either way.'}
                </p>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
