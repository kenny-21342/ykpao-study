/**
 * Vision LLM client for transcribing handwritten student work to text.
 *
 * Under bring-your-own-key this module holds no key of its own. The caller
 * resolves a `VisionCredential` for the signed-in user (lib/ai-credentials.ts)
 * and passes it in. Two request shapes are supported:
 *
 *   - `openai-compatible` — every user-supplied endpoint, plus the owner's
 *     SiliconFlow key. One `/chat/completions` call with one `image_url` part
 *     per image.
 *   - `gemini` — only ever reached through the owner's shared server key,
 *     which predates BYOK and uses the native generateContent API.
 *
 * A user who supplied only a text model has no vision credential at all; the
 * route gate (`requireVisionAi`) turns that into a specific, actionable
 * message rather than a silent fallback. Callers that treat OCR as an
 * enhancement still get `null` on a failed call and grade the typed answer.
 *
 * Unlike the Python pipeline (which extracts structured JSON from PDF pages),
 * this module is purpose-built for marking: OCR a student's handwritten answer
 * into text the text grader can read, or mark an image answer directly. Both
 * provider calls take a *list* of images, because a bank question is stored as
 * several cropped strips that only mean anything read together.
 */

import type { VisionCredential } from "@/lib/ai-credentials";
import type { GradeResult } from "@/types/ai";

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

/**
 * Grades a diagram/drawing directly, rather than OCR-then-text-grade.
 *
 * OCR transcription is prompted to transcribe *text*, so a graph, circuit, or
 * geometric construction degrades badly: there is no text to extract, only a
 * picture whose content itself is the answer. This prompt instead asks the
 * vision model to look at the image and mark it, using the exact JSON
 * contract `SYSTEM_PROMPTS.grader` already defines so both text and vision
 * grading paths produce the same shape for callers.
 */
const VISION_GRADE_SYSTEM = `You are a strict but fair examiner grading a student's handwritten or drawn answer, shown to you as a photo, against a markscheme.

The answer may be a diagram, graph, circuit, geometric construction, or labelled sketch as well as (or instead of) written text — evaluate what is actually drawn, not only any accompanying prose. Do not ask for a transcription or claim the image cannot be read; describe and grade what you see.

Return JSON only, no prose outside JSON, no markdown code fences. Schema:
{
  "score": number,            // marks awarded (can be fractional)
  "maxScore": number,         // total marks possible
  "isCorrect": boolean,       // true if essentially full marks
  "strengths": string[],      // what the student did well, referencing the diagram/drawing where relevant
  "weaknesses": string[],     // specific mistakes, referencing the diagram/drawing where relevant
  "explanation": string,      // markdown + LaTeX explanation of how to improve
  "modelAnswer": string       // a concise model answer in markdown + LaTeX
}`;

/**
 * Transcribe a *printed exam question* from its cropped strips.
 *
 * Deliberately not the handwriting prompt. That one is told to transcribe a
 * student's working and nothing else; this one is reading a typeset question
 * whose structure carries marks -- part labels, mark allocations, tables,
 * figures. Dropping "[3]" or collapsing "(b)(ii)" into prose makes the
 * transcript unusable for grading, which is the whole point of producing it.
 */
const TRANSCRIBE_QUESTION_SYSTEM = `You transcribe a printed exam question, shown to you as one or more cropped images read top to bottom, into clean markdown.

Rules:
1. Output ONLY the transcription. No preamble, no commentary, no code fences.
2. NEVER answer the question, and never add working, hints or explanation. Transcribe what is printed and stop.
3. Preserve the question's structure exactly: part labels such as (a), (b)(i), (c)(ii) stay on their own lines, in order.
4. Preserve every mark allocation exactly as printed, including the brackets: [3], [1], (2).
5. Preserve every mathematical or chemical expression as LaTeX: inline $...$, display $$...$$, arrows $\\rightarrow$ / $\\rightleftharpoons$.
6. Tables become LaTeX arrays inside $$...$$.
7. A figure, graph, circuit or diagram cannot be transcribed as text, so describe it in square brackets on its own line, specifically enough to answer from: [Figure: a velocity-time graph, velocity in m/s on the y-axis from 0 to 20, time in s on the x-axis from 0 to 8; the line rises linearly from the origin to (4, 20) then stays flat to (8, 20).] Include every printed axis label, unit, scale and annotation.
8. If part of an image is illegible, write [illegible] and continue. Never invent text.
9. The images are consecutive crops of one question: transcribe them as a single continuous question, not as separate ones.`;

const TRANSCRIBE_QUESTION_USER = `Transcribe this exam question. Keep the part labels, the mark allocations and the figures. Do not answer it.`;

/**
 * Transcribe a *mark scheme* from its cropped strips.
 *
 * Separate from the question prompt because a mark scheme is a marking grid,
 * not prose: the award conditions and their marks are the content, and a
 * summary of them grades nothing.
 */
const TRANSCRIBE_MARKSCHEME_SYSTEM = `You transcribe a printed exam mark scheme, shown to you as one or more cropped images read top to bottom, into clean markdown.

Rules:
1. Output ONLY the transcription. No preamble, no commentary, no code fences.
2. Preserve the structure: part labels ((a), (b)(i)), each accepted answer, and the marks awarded for each.
3. Preserve marking notation verbatim -- M1, A1, B1, C1, ecf, owtte, cao, "allow", "accept", "reject", "ignore", "or equivalent".
4. Preserve every mathematical or chemical expression as LaTeX: inline $...$, display $$...$$.
5. Tables and marking grids become LaTeX arrays inside $$...$$, or markdown tables where that reads more clearly.
6. Never add marking points that are not printed, and never rewrite a condition into your own words.
7. If part of an image is illegible, write [illegible] and continue.`;

const TRANSCRIBE_MARKSCHEME_USER = `Transcribe this mark scheme. Keep every marking point, its notation and its marks. Do not add any of your own.`;

/** Image extensions this module is willing to read off disk, and their mime types. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

type RetryOpts = { maxRetries?: number; delays?: number[]; budgetMs?: number; requestTimeoutMs?: number };

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

/**
 * Grading is not OCR, and must not inherit OCR's deadline.
 *
 * The budget above is deliberately short because a failed transcription costs
 * the caller nothing -- it falls back to grading the typed answer. A failed
 * *grade* costs the student their result. And it is a much longer call: the
 * model writes a whole JSON verdict, with strengths, weaknesses, an
 * explanation and a model answer, where OCR writes back a transcript.
 * Measured against the production model, a single grading attempt runs past
 * the 15s per-attempt ceiling, so every attempt aborted, the retries spent the
 * 20s budget, and the caller got a silent null.
 *
 * The ceiling this has to sit under is the caller's `maxDuration`: 60 in
 * /api/practice, and 180 in the mock-exam submit route, which also has to fit
 * a transcription call ahead of the grade.
 */
const VISION_GRADE_BUDGET_MS = Number(process.env.VISION_GRADE_BUDGET_MS || 45_000);
const VISION_GRADE_REQUEST_TIMEOUT_MS = 40_000;

/** Per-request timeout; never longer than what is left of the budget. */
const VISION_REQUEST_TIMEOUT_MS = 15_000;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * How long this attempt may take, and whether it is worth starting at all.
 * Returns null once the budget is spent.
 */
function attemptTimeout(deadline: number, ceiling = VISION_REQUEST_TIMEOUT_MS): number | null {
  const remaining = deadline - Date.now();
  if (remaining < 1_000) return null;
  return Math.min(ceiling, remaining);
}

/** Back off, but never past the deadline. Returns false if there is no time left. */
async function backoff(deadline: number, seconds: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  if (remaining < 2_000) return false;
  await sleep(Math.min(seconds * 1000, remaining - 1_000));
  return true;
}

/**
 * An image that has been turned into something a provider will accept: either
 * inline base64 bytes, or a remote URL the provider fetches itself.
 */
export type ResolvedImage =
  | { kind: "data"; mime: string; b64: string }
  | { kind: "url"; url: string };

/**
 * What a provider says the call actually cost. Both APIs report this and both
 * calls used to drop it, so every vision grade was booked at a flat estimate.
 * Optional throughout: a provider that omits the block leaves the caller on
 * its estimate rather than recording a zero.
 */
export type ProviderUsage = { tokensIn?: number; tokensOut?: number };

type ProviderResult = { content: string; usage: ProviderUsage | null };

/**
 * Ceiling on how many images go into one call.
 *
 * Bank questions are stored as cropped strips: the corpus averages 1.85 per
 * question and the 95th percentile is 5, so this clears the real distribution
 * with room to spare. The tail runs to 25 strips, and those are not worth the
 * image tokens -- a question that long is a whole page of sub-parts, and
 * truncating it costs less than paying for every one on every call.
 */
export const MAX_VISION_IMAGES = 8;

/**
 * Fallback token count for a vision grade whose provider reported no usage.
 *
 * Both submit routes used to book this flat number unconditionally. It stays
 * only as the fallback -- an estimate is wrong, but recording nothing showed a
 * real, paid call on /usage as costing nothing at all.
 */
export const VISION_GRADE_TOKENS_ESTIMATE = 800;

/**
 * Convert a data URL (e.g. "data:image/png;base64,...") or a server-relative
 * file URL (e.g. "/uploads/images/foo.png") into a base64 payload plus mime
 * type. Returns null if the URL cannot be resolved.
 *
 * Data URLs are split directly; file URLs are read from the object store.
 * Absolute https URLs are passed through to the vision API verbatim
 * (SiliconFlow accepts remote URLs).
 */
async function resolveImage(input: string): Promise<ResolvedImage | null> {
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
    const { KEY_PREFIX } = await import("./storage/index.ts");
    return readFromStorage(input, [KEY_PREFIX.uploads]);
  }
  return null;
}

/**
 * `resolveImage`, but for paths the *server* derived rather than the client.
 *
 * Question strips live under the `bank_assets` prefix, which `resolveImage`
 * refuses on purpose: its input arrives straight from request bodies, and a
 * path that escapes the uploads prefix is bytes shipped to a third-party API.
 * That containment does not loosen. This sibling exists so the transcription
 * path can read strips, and it may only be given a path the server built
 * itself — in practice `toStrips()` in lib/bank-questions.ts, whose URLs come
 * from `bankAssetKey(sha256)` and are rejected unless the digest is 64 hex
 * characters. Never pass it anything a request supplied.
 */
export async function resolveTrustedImage(publicPath: string): Promise<ResolvedImage | null> {
  const m = publicPath.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (m) return { kind: "data", mime: m[1], b64: m[2] };
  if (/^https?:\/\//i.test(publicPath)) return { kind: "url", url: publicPath };
  if (!publicPath.startsWith("/")) return null;

  const { KEY_PREFIX } = await import("./storage/index.ts");
  return readFromStorage(publicPath, [KEY_PREFIX.uploads, KEY_PREFIX.bankAssets]);
}

/**
 * Read a server-relative public path out of the object store, but only if its
 * key sits under one of `allowedPrefixes` and names a real image extension.
 *
 * `keyFromPublicPath` percent-decodes and rejects traversal; the prefix check
 * keeps a resolved key inside the caller's allow-list, and the extension check
 * means a key that somehow slipped through still cannot pull back a .env or a
 * .ts file.
 */
async function readFromStorage(
  publicPath: string,
  allowedPrefixes: string[]
): Promise<ResolvedImage | null> {
  try {
    const { getStorage, keyFromPublicPath } = await import("./storage/index.ts");

    const key = keyFromPublicPath(publicPath);
    if (!key || !allowedPrefixes.some((prefix) => key.startsWith(`${prefix}/`))) return null;

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

/**
 * Read a provider's usage block, keeping only counts that are real numbers.
 * An absent or malformed block yields null, which the caller reads as "no
 * count reported" and falls back to its estimate -- recording zero instead
 * would show a real, paid call as free on /usage.
 */
function readOpenAiUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
): ProviderUsage | null {
  return normalizeUsage(usage?.prompt_tokens, usage?.completion_tokens);
}

function readGeminiUsage(
  usage: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined
): ProviderUsage | null {
  return normalizeUsage(usage?.promptTokenCount, usage?.candidatesTokenCount);
}

function normalizeUsage(tokensIn: unknown, tokensOut: unknown): ProviderUsage | null {
  const inCount = Number.isFinite(tokensIn) ? Number(tokensIn) : undefined;
  const outCount = Number.isFinite(tokensOut) ? Number(tokensOut) : undefined;
  if (inCount === undefined && outCount === undefined) return null;
  return { tokensIn: inCount, tokensOut: outCount };
}

async function callOpenAiCompatible(
  credential: VisionCredential,
  images: ResolvedImage[],
  systemPrompt: string,
  userText: string,
  opts: RetryOpts = {}
): Promise<ProviderResult | null> {
  const maxRetries = opts.maxRetries ?? 5;
  const delays = opts.delays ?? DEFAULT_DELAYS;

  if (images.length === 0) return null;

  const parts = images.slice(0, MAX_VISION_IMAGES).map((resolved) => ({
    type: "image_url" as const,
    image_url: {
      url:
        resolved.kind === "data"
          ? `data:${resolved.mime};base64,${resolved.b64}`
          : resolved.url,
    },
  }));

  const payload = {
    model: credential.model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [{ type: "text", text: userText }, ...parts],
      },
    ],
    temperature: 0.1,
    max_tokens: 2048,
  };

  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_VISION_BUDGET_MS);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const timeout = attemptTimeout(deadline, opts.requestTimeoutMs);
    if (timeout === null) {
      // Every `return null` below is indistinguishable to the caller, and a
      // caller that treats null as "no result" has no way to tell a timeout
      // from a rejected key. Say which one it was.
      console.warn("vision: budget exhausted before attempt", attempt + 1, credential.model);
      return null;
    }
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
        console.warn("vision: retryable status", res.status, "attempt", attempt + 1);
        if (!(await backoff(deadline, delays[Math.min(attempt, delays.length - 1)]))) return null;
        continue;
      }

      if (!res.ok) {
        console.warn("vision: request rejected", res.status, credential.model);
        return null;
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content || !content.trim()) {
        console.warn("vision: empty completion", credential.model);
        return null;
      }
      return { content: content.trim(), usage: readOpenAiUsage(data.usage) };
    } catch (err) {
      console.warn("vision: attempt", attempt + 1, "failed:", err instanceof Error ? err.message : err);
      if (!(await backoff(deadline, delays[Math.min(attempt, delays.length - 1)]))) return null;
    }
  }
  console.warn("vision: exhausted", maxRetries, "attempts", credential.model);
  return null;
}

async function callGemini(
  credential: VisionCredential,
  images: ResolvedImage[],
  systemPrompt: string,
  userText: string,
  opts: RetryOpts = {}
): Promise<ProviderResult | null> {
  const maxRetries = opts.maxRetries ?? 5;
  const delays = opts.delays ?? DEFAULT_DELAYS;

  if (images.length === 0) return null;

  const inline = images.slice(0, MAX_VISION_IMAGES);
  if (inline.some((image) => image.kind === "url")) {
    // Gemini accepts fileData for remote URLs, but only for GCS or URLs it can
    // fetch. One unfetchable image would poison the whole call, so bail if any
    // of them is a URL rather than send a partial question.
    return null;
  }

  const payload = {
    contents: [
      {
        role: "user",
        parts: [
          { text: userText },
          ...inline.map((image) => ({
            inline_data: {
              mime_type: (image as { kind: "data"; mime: string; b64: string }).mime,
              data: (image as { kind: "data"; mime: string; b64: string }).b64,
            },
          })),
        ],
      },
    ],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 2048,
    },
  };

  const url = `${credential.endpoint.replace(/\/+$/, "")}/models/${credential.model}:generateContent?key=${credential.apiKey}`;

  const deadline = Date.now() + (opts.budgetMs ?? DEFAULT_VISION_BUDGET_MS);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const timeout = attemptTimeout(deadline, opts.requestTimeoutMs);
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
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text || !text.trim()) return null;
      return { content: text.trim(), usage: readGeminiUsage(data.usageMetadata) };
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

  const result =
    credential.provider === "gemini"
      ? await callGemini(credential, [resolved], TRANSCRIBE_SYSTEM, TRANSCRIBE_USER)
      : await callOpenAiCompatible(credential, [resolved], TRANSCRIBE_SYSTEM, TRANSCRIBE_USER, {
          // A user-supplied endpoint is far likelier to be a typo than the
          // owner's pinned SiliconFlow one, so do not spend the whole budget
          // retrying it.
          maxRetries: credential.source === "user" ? 2 : 5,
        });
  return result?.content ?? null;
}

/**
 * Grade a photographed or drawn answer directly from its image, for
 * questions where OCR-then-text-grade would throw away the content that
 * actually needs marking (a diagram, graph, circuit, or construction).
 *
 * Returns the same `GradeResult` shape `SYSTEM_PROMPTS.grader` produces, so
 * callers do not need a separate code path depending on which grader ran —
 * or `null` if the image can't be resolved, the credential is unusable, or
 * the provider's response isn't parseable JSON (callers should fall back to
 * OCR-then-text-grade on null, same contract as `transcribeHandwriting`).
 */
export async function gradeWithVision(params: {
  imageUrl: string;
  questionText: string;
  /** The typed answer that accompanies the image, if the student wrote one. */
  studentText?: string | null;
  markscheme?: string | null;
  totalMarks?: number | null;
  credential: VisionCredential;
}): Promise<{ grade: GradeResult; usage: ProviderUsage | null } | null> {
  const { imageUrl, questionText, studentText, markscheme, totalMarks, credential } = params;
  if (!credential?.apiKey || !credential.endpoint || !credential.model) return null;

  // Grading against an empty question is grading against nothing: the model
  // reports it cannot tell what was asked and returns zero, which the caller
  // then persists as a real mark. Callers gate on this too
  // (`decideGradingMode`); refuse here as well so no future caller can route
  // an untranscribed question in by accident.
  if (!questionText.trim()) {
    console.warn("gradeWithVision: refusing to grade with no question text", imageUrl);
    return null;
  }

  const resolved = await resolveImage(imageUrl);
  if (!resolved) {
    console.warn("gradeWithVision: could not resolve image", imageUrl);
    return null;
  }

  const typed = studentText?.trim();
  const userText = `Grade the student's answer against the markscheme.

Question:
${questionText}

${markscheme ? `Markscheme:\n${markscheme}\n\n` : ''}${totalMarks ? `Total marks: ${totalMarks}\n\n` : ''}${
    typed
      ? `The student answered in two parts, and both are their answer: the typed text below, and the attached image showing their diagram or working. Mark them together as one response -- credit a point made in either.

Student's typed answer:
${typed}`
      : "The student's answer is the image attached to this message."
  }`;

  const retryOpts: RetryOpts = {
    maxRetries: credential.source === "user" ? 2 : 5,
    budgetMs: VISION_GRADE_BUDGET_MS,
    requestTimeoutMs: VISION_GRADE_REQUEST_TIMEOUT_MS,
  };
  const result =
    credential.provider === "gemini"
      ? await callGemini(credential, [resolved], VISION_GRADE_SYSTEM, userText, retryOpts)
      : await callOpenAiCompatible(credential, [resolved], VISION_GRADE_SYSTEM, userText, retryOpts);
  if (!result) return null;

  const grade = parseGradeJson(result.content);
  return grade ? { grade, usage: result.usage } : null;
}

/** The model is asked for bare JSON but sometimes wraps it in prose. */
function parseGradeJson(raw: string): GradeResult | null {
  try {
    return JSON.parse(raw) as GradeResult;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start !== -1 && end !== -1) {
      try {
        return JSON.parse(raw.slice(start, end + 1)) as GradeResult;
      } catch {
        // fall through to the warning below
      }
    }
    console.warn("gradeWithVision: response was not JSON:", raw.slice(0, 200));
    return null;
  }
}

/**
 * Transcribe a bank question from its cropped strips.
 *
 * The crop-first bank stores a question as images and leaves `bodyMd` empty,
 * and `lib/bank-questions.ts` states what that costs: everything that reasons
 * over a question rather than displaying it -- hints, AI grading, search --
 * needs the text and is gated off without it. This is the paid pass that
 * fills it in.
 *
 * `stripUrls` must be server-derived (`toStrips()`), in reading order; they
 * are read through `resolveTrustedImage`, which is the only resolver that
 * will touch the bank-asset prefix. Returns null if no strip resolves or the
 * provider call fails -- callers must treat that as "still untranscribed" and
 * fall back to their existing ungraded path, never as an empty transcript.
 */
export async function transcribeBankQuestion(
  stripUrls: string[],
  credential: VisionCredential,
  opts: RetryOpts = {}
): Promise<{ text: string; usage: ProviderUsage | null } | null> {
  return transcribeStrips(stripUrls, credential, TRANSCRIBE_QUESTION_SYSTEM, TRANSCRIBE_QUESTION_USER, opts);
}

/** The same pass for a mark scheme's strips. See `transcribeBankQuestion`. */
export async function transcribeBankMarkScheme(
  stripUrls: string[],
  credential: VisionCredential,
  opts: RetryOpts = {}
): Promise<{ text: string; usage: ProviderUsage | null } | null> {
  return transcribeStrips(stripUrls, credential, TRANSCRIBE_MARKSCHEME_SYSTEM, TRANSCRIBE_MARKSCHEME_USER, opts);
}

async function transcribeStrips(
  stripUrls: string[],
  credential: VisionCredential,
  systemPrompt: string,
  userText: string,
  opts: RetryOpts
): Promise<{ text: string; usage: ProviderUsage | null } | null> {
  if (!credential?.apiKey || !credential.endpoint || !credential.model) return null;
  if (stripUrls.length === 0) return null;

  // Resolve in order and keep the order: the strips are consecutive crops of
  // one question, and shuffling them would hand the model a scrambled
  // question. A strip that fails to resolve is dropped rather than aborting
  // the whole call -- a question missing its last crop still transcribes
  // better than nothing -- but if none resolve there is nothing to send.
  const resolved: ResolvedImage[] = [];
  for (const url of stripUrls.slice(0, MAX_VISION_IMAGES)) {
    const image = await resolveTrustedImage(url);
    if (image) resolved.push(image);
  }
  if (resolved.length === 0) {
    console.warn("transcribeStrips: no strip resolved", stripUrls.length, "candidates");
    return null;
  }

  const result =
    credential.provider === "gemini"
      ? await callGemini(credential, resolved, systemPrompt, userText, opts)
      : await callOpenAiCompatible(credential, resolved, systemPrompt, userText, {
          maxRetries: credential.source === "user" ? 2 : 5,
          ...opts,
        });
  if (!result) return null;
  return { text: result.content, usage: result.usage };
}
