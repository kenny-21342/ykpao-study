/**
 * Vision LLM client for transcribing handwritten student work to text.
 *
 * Mirrors the backend selection logic in pdf_extraction/lib/vision_client.py:
 *   - If SILICONFLOW_API_KEY is set  → SiliconFlow (OpenAI-compatible)
 *   - Else if GEMINI_API_KEY is set  → Gemini native API
 *   - Else throws
 *
 * Unlike the Python pipeline (which extracts structured JSON from PDF pages),
 * this module is purpose-built for one task: OCR a single image of a student's
 * handwritten answer and return plain text/LaTeX suitable for the DeepSeek
 * grader. Returns null on failure so callers can fall back to text-only input.
 */

const SILICONFLOW_KEY = process.env.SILICONFLOW_API_KEY || "";
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";

const SF_BASE = "https://api.siliconflow.cn/v1/chat/completions";
const SF_MODEL = process.env.VISION_MODEL || "Qwen/Qwen3-VL-32B-Instruct";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const GEMINI_API_BASE =
  process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta";

export type VisionBackend = "siliconflow" | "gemini";

export function getVisionBackend(): VisionBackend | null {
  if (SILICONFLOW_KEY) return "siliconflow";
  if (GEMINI_KEY) return "gemini";
  return null;
}

export function isVisionConfigured() {
  return getVisionBackend() !== null;
}

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

type RetryOpts = { maxRetries?: number; delays?: number[] };

const DEFAULT_DELAYS = [2, 5, 12, 20, 30];

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

async function callSiliconFlow(
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
    model: SF_MODEL,
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

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(SF_BASE, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SILICONFLOW_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      if (res.status === 429 || res.status >= 500) {
        const delay = delays[Math.min(attempt, delays.length - 1)] * 1000;
        await sleep(delay);
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
      const delay = delays[Math.min(attempt, delays.length - 1)] * 1000;
      await sleep(delay);
    }
  }
  return null;
}

async function callGemini(
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

  const url = `${GEMINI_API_BASE}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.status === 429 || res.status >= 500) {
        const delay = delays[Math.min(attempt, delays.length - 1)] * 1000;
        await sleep(delay);
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
      const delay = delays[Math.min(attempt, delays.length - 1)] * 1000;
      await sleep(delay);
    }
  }
  return null;
}

/**
 * Transcribe an image of handwritten student work into text.
 *
 * Accepts a data URL, a server-relative file URL (under public/), or an
 * https URL. Returns the transcription as plain markdown + LaTeX, or null
 * if no vision backend is configured or the call fails.
 *
 * Callers should fall back to text-only grading when this returns null.
 */
export async function transcribeHandwriting(imageInput: string): Promise<string | null> {
  const backend = getVisionBackend();
  if (!backend) return null;

  const resolved = await resolveImage(imageInput);
  if (!resolved) return null;

  if (backend === "siliconflow") return callSiliconFlow(resolved);
  return callGemini(resolved);
}
