/**
 * Vision LLM client for transcribing handwritten student work to text.
 *
 * Under bring-your-own-key this module holds no key of its own. The caller
 * resolves a `VisionCredential` for the signed-in user (lib/ai-credentials.ts)
 * and passes it in. Two request shapes are supported:
 *
 *   - `openai-compatible` — every user-supplied endpoint, plus the owner's
 *     SiliconFlow key. One `/chat/completions` call with an `image_url` part.
 *   - `gemini` — only ever reached through the owner's shared server key,
 *     which predates BYOK and uses the native generateContent API.
 *
 * A user who supplied only a text model has no vision credential at all; the
 * route gate (`requireVisionAi`) turns that into a specific, actionable
 * message rather than a silent fallback. Callers that treat OCR as an
 * enhancement still get `null` on a failed call and grade the typed answer.
 *
 * Unlike the Python pipeline (which extracts structured JSON from PDF pages),
 * this module is purpose-built for one task: OCR a single image of a student's
 * handwritten answer and return plain text/LaTeX suitable for the text grader.
 */

import type { VisionCredential } from "@/lib/ai-credentials";

const TRANSCRIBE_SYSTEM = `You transcribe handwritten student work from a photo into clean, gradeable text.

Rules:
1. Output ONLY the transcription. No preamble, no "Here is...", no commentary.
2. Preserve every mathematical expression as LaTeX:
   - Inline math: $...$   (e.g. $E = mc^2$, $x^2 + y^2$)
   - Display math: $$...$$
3. Keep working-out steps on separate lines. Do not collapse steps.
4. Chemical equations use LaTeX arrows: $\\rightarrow$, $\\rightleftharpoons$.
5. Tables become LaTeX arrays inside $$...$$.
6. If a part of the image is illegible, write [illegible] and continue.
7. Never fabricate steps that are not visible. Never solve the problem.
8. Do NOT wrap the output in code fences or quote it.`;

const TRANSCRIBE_USER = `Transcribe the handwritten answer(s) in this image. Preserve the student's exact working — every line, every equation, every annotation. Output plain markdown + LaTeX, nothing else.`;

/** Image extensions this module is willing to read off disk, and their mime types. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

type RetryOpts = { maxRetries?: number; delays?: number[]; budgetMs?: number };

const DEFAULT_DELAYS = [2, 5, 12, 20, 30];

/**
 * Wall-clock ceiling for a whole transcription, retries and backoff included.
 *
 * The retry ladder above sleeps for up to 69 seconds before it gives up, and
 * `fetch` has no timeout of its own — so a rate-limited or stalled vision API
 * could outlast the entire serverless invocation. That matters most in
 * `/api/mock-exams/[id]/submit`, where OCR runs *per item* ahead of grading: a
 * flapping vision backend would consume the whole 60s budget on sleeping and
 * take every question's grading down with it. OCR is a best-effort enhancement
 * (callers fall back to text-only grading on `null`), so it must fail fast.
 */
const DEFAULT_VISION_BUDGET_MS = Number(process.env.VISION_BUDGET_MS || 20_000);

/** Per-request timeout; never longer than what is left of the budget. */
const VISION_REQUEST_TIMEOUT_MS = 15_000;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * How long this attempt may take, and whether it is worth starting at all.
 * Returns null once the budget is spent.
 */
function attemptTimeout(deadline: number): number | null {
  const remaining = deadline - Date.now();
  if (remaining < 1_000) return null;
  return Math.min(VISION_REQUEST_TIMEOUT_MS, remaining);
}

/** Back off, but never past the deadline. Returns false if there is no time left. */
async function backoff(deadline: number, seconds: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining < 2_000) return false;
  await sleep(Math.min(seconds * 1000, remaining - 1_000));
  return true;
}

/**
 * Convert a data URL (e.g. "data:image/png;base64,...") or a server-relative
 * file URL (e.g. "/uploads/images/foo.png") into a base64 payload plus mime
 * type. Returns null if the URL cannot be resolved.
 *
 * Data URLs are split directly; file URLs are read from the object store.
 * Absolute https URLs are passed through to the vision API verbatim
 * (SiliconFlow accepts remote URLs).
 */
async function resolveImage(
  input: string
): Promise<{ kind: "data"; mime: string; b64: string } | { kind: "url"; url: string } | null> {
  // Already a data URL
  const m = input.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (m) return { kind: "data", mime: m[1], b64: m[2] };

  // Remote URL — let the API fetch it
  if (/^https?:\/\//i.test(input)) return { kind: "url", url: input };

  // Server-relative URL — read from the uploads prefix of the object store.
  //
  // The caller-supplied path is untrusted: it arrives straight from request
  // bodies (/api/practice, /api/practice/ocr, /api/mock-exams/[id]/submit).
  // Without containment, "/../../.env" would escape the uploads prefix and the
  // bytes would then be shipped to a third-party vision API. `keyFromPublicPath`
  // percent-decodes and then rejects traversal, and the prefix check below
  // keeps this to uploads only — never papers or V3 assets.
  if (input.startsWith("/")) {
    try {
      const { getStorage, KEY_PREFIX, keyFromPublicPath } = await import(
        "./storage/index.ts"
      );

      const key = keyFromPublicPath(input);
      if (!key || !key.startsWith(`${KEY_PREFIX.uploads}/`)) return null;

      const path = await import("path");
      const ext = path.extname(key).toLowerCase();
      const mime = IMAGE_MIME_BY_EXT[ext];
      // Only ever read real image extensions — never .env, .ts, .pdf, …
      if (!mime) return null;

      const object = await getStorage().get(key);
      if (!object) return null;
      return { kind: "data", mime, b64: object.bytes.toString("base64") };
    } catch {
      return null;
    }
  }
  return null;
}

async function callOpenAiCompatible(
  credential: VisionCredential,
  resolved: { kind: "data"; mime: string; b64: string } | { kind: "url"; url: string },
  opts: RetryOpts = {}
): Promise<string | null> {
  const maxRetries = opts.maxRetries ?? 5;
  const delays = opts.delays ?? DEFAULT_DELAYS;

  const imageUrl =
    resolved.kind === "data"
      ? `data:${resolved.mime};base64,${resolved.b64}`
      : resolved.url;

  const payload = {
    model: credential.model,
    messages: [
      { role: "system", content: TRANSCRIBE_SYSTEM },
      {
        role: "user",
        content: [
          { type: "text", text: TRANSCRIBE_USER },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 2048,
  };

  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_VISION_BUDGET_MS);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const timeout = attemptTimeout(deadline);
    if (timeout === null) return null;
    try {
      const res = await fetch(credential.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
      });

      if (res.status === 429 || res.status >= 500) {
        if (!(await backoff(deadline, delays[Math.min(attempt, delays.length - 1)]))) return null;
        continue;
      }

      if (!res.ok) {
        return null;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content || !content.trim()) return null;
      return content.trim();
    } catch {
      if (!(await backoff(deadline, delays[Math.min(attempt, delays.length - 1)]))) return null;
    }
  }
  return null;
}

async function callGemini(
  credential: VisionCredential,
  resolved: { kind: "data"; mime: string; b64: string } | { kind: "url"; url: string },
  opts: RetryOpts = {}
): Promise<string | null> {
  const maxRetries = opts.maxRetries ?? 5;
  const delays = opts.delays ?? DEFAULT_DELAYS;

  if (resolved.kind === "url") {
    // Gemini accepts fileData for remote URLs, but only for GCS or URLs it can
    // fetch. We pass it through and let the API decide.
    return null;
  }

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          { text: TRANSCRIBE_USER },
          { inline_data: { mime_type: resolved.mime, data: resolved.b64 } },
        ],
      },
    ],
    systemInstruction: { parts: [{ text: TRANSCRIBE_SYSTEM }] },
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
    },
  };

  const url = `${credential.endpoint.replace(/\/+$/, "")}/models/${credential.model}:generateContent?key=${credential.apiKey}`;

  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_VISION_BUDGET_MS);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const timeout = attemptTimeout(deadline);
    if (timeout === null) return null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
      });

      if (res.status === 429 || res.status >= 500) {
        if (!(await backoff(deadline, delays[Math.min(attempt, delays.length - 1)]))) return null;
        continue;
      }

      if (!res.ok) {
        return null;
      }

      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text || !text.trim()) return null;
      return text.trim();
    } catch {
      if (!(await backoff(deadline, delays[Math.min(attempt, delays.length - 1)]))) return null;
    }
  }
  return null;
}

/**
 * Transcribe an image of handwritten student work into text.
 *
 * Accepts a data URL, a server-relative file URL (under the uploads prefix),
 * or an https URL. Returns the transcription as plain markdown + LaTeX, or
 * null if the image cannot be resolved or the provider call fails.
 *
 * The credential is mandatory — whether the user has vision at all is decided
 * upstream by `requireVisionAi`, so that "you have no vision model" can be
 * reported as a specific message instead of arriving here as a null.
 *
 * Callers should fall back to text-only grading when this returns null.
 */
export async function transcribeHandwriting(
  imageInput: string,
  credential: VisionCredential,
): Promise<string | null> {
  if (!credential?.apiKey || !credential.endpoint || !credential.model) return null;

  const resolved = await resolveImage(imageInput);
  if (!resolved) return null;

  if (credential.provider === "gemini") return callGemini(credential, resolved);
  return callOpenAiCompatible(credential, resolved, {
    // A user-supplied endpoint is far likelier to be a typo than the owner's
    // pinned SiliconFlow one, so do not spend the whole budget retrying it.
    maxRetries: credential.source === "user" ? 2 : 5,
  });
}
