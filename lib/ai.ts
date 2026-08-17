import { DeepSeekMessage, DeepSeekResponse } from '@/types/ai';

const API_KEY = process.env.DEEPSEEK_API_KEY;
const API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/v1/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

export class DeepSeekError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'DeepSeekError';
  }
}

export function isAIConfigured() {
  return Boolean(API_KEY);
}

/**
 * Wall-clock ceiling for one `chat()` call, retries included.
 *
 * `fetch` has no default timeout: without this, a DeepSeek connection that
 * accepts the request and then stalls hangs until the *platform* kills the
 * whole invocation at `maxDuration`, so the user watches a spinner for a
 * minute and then gets an opaque gateway error. Bounding it here means the
 * route still owns its remaining time and can return something explanatory.
 *
 * Keep this comfortably below the 60s `maxDuration` the route handlers
 * declare. Callers that fan out (mock-exam grading runs `GRADING_CONCURRENCY`
 * of these per submission) must pass a smaller `budgetMs` of their own.
 */
const DEFAULT_BUDGET_MS = Number(process.env.AI_REQUEST_BUDGET_MS || 45_000);

/** Attempts per call, including the first. Two is one bounded retry. */
const DEFAULT_MAX_ATTEMPTS = 2;

export type ChatOptions = {
  temperature?: number;
  maxTokens?: number;
  jsonResponse?: boolean;
  /** Total wall-clock budget for the call, retries and backoff included. */
  budgetMs?: number;
  /** Total attempts, including the first. 1 disables retrying. */
  maxAttempts?: number;
  /** Caller cancellation (e.g. the client disconnected). */
  signal?: AbortSignal;
};

/** Transient upstream conditions worth one more attempt. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function chat(
  messages: DeepSeekMessage[],
  options: ChatOptions = {}
): Promise<string> {
  if (!API_KEY) {
    throw new DeepSeekError('DeepSeek API key is not configured (DEEPSEEK_API_KEY)', 503);
  }

  const {
    temperature = 0.7,
    maxTokens = 2000,
    jsonResponse = false,
    budgetMs = DEFAULT_BUDGET_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    signal,
  } = options;

  const body: Record<string, unknown> = {
    model: MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonResponse) {
    body.response_format = { type: 'json_object' };
  }

  const deadline = Date.now() + Math.max(1_000, budgetMs);
  const attempts = Math.max(1, maxAttempts);
  let lastError: DeepSeekError = new DeepSeekError('DeepSeek request was not attempted', 503);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const remaining = deadline - Date.now();
    // Not enough left to be worth starting: fail with what we know rather than
    // firing a request the platform will kill mid-flight.
    if (remaining < 1_000) break;

    // Reserve time for a retry when one is still available.
    const attemptMs =
      attempt < attempts ? Math.max(5_000, Math.floor(remaining * 0.6)) : remaining;

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), attemptMs);

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        // The upstream body can echo back the prompt (which may contain a
        // student's answer) and sometimes account/billing detail. Log it for
        // operators; never let it reach the client, since several routes return
        // `error.message` verbatim.
        const detail = await res.text();
        console.error(`DeepSeek request failed (${res.status}):`, detail.slice(0, 2000));
        lastError = new DeepSeekError(
          res.status === 429
            ? 'The AI service is rate-limited right now. Please try again in a moment.'
            : `DeepSeek request failed (${res.status})`,
          res.status
        );
        if (!isRetryableStatus(res.status)) throw lastError;
      } else {
        const data = (await res.json()) as DeepSeekResponse;
        const content = data.choices?.[0]?.message?.content;
        if (content) return content;
        lastError = new DeepSeekError('DeepSeek returned an empty response', 502);
      }
    } catch (err) {
      if (err instanceof DeepSeekError) throw err;

      // The caller gave up (client disconnected): stop, don't retry.
      if (signal?.aborted) {
        throw new DeepSeekError('The request was cancelled', 499);
      }
      const timedOut = err instanceof Error && err.name === 'AbortError';
      console.error('DeepSeek request error:', timedOut ? `timed out after ${attemptMs}ms` : err);
      lastError = timedOut
        ? new DeepSeekError(
            'The AI service did not respond in time. Please try again.',
            504
          )
        : new DeepSeekError('Could not reach the AI service. Please try again.', 503);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    // Short, bounded backoff — only if there is real time left to use it.
    const left = deadline - Date.now();
    if (attempt < attempts && left > 3_000) {
      await sleep(Math.min(750 * attempt, left - 2_000));
    }
  }

  throw lastError;
}

export async function chatJSON<T = unknown>(
  messages: DeepSeekMessage[],
  options: Omit<ChatOptions, 'jsonResponse'> = {}
): Promise<T> {
  const raw = await chat(messages, { ...options, jsonResponse: true });
  try {
    return JSON.parse(raw) as T;
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      return JSON.parse(raw.slice(start, end + 1)) as T;
    }
    throw new DeepSeekError('DeepSeek did not return valid JSON', 502);
  }
}

export const SYSTEM_PROMPTS = {
  tutor: `You are an intelligent tutor helping students learn.

IMPORTANT FORMATTING RULES:
1. For mathematical formulas, ALWAYS use LaTeX notation:
   - Inline math: $formula$ (e.g., $E = mc^2$, $x^2 + y^2$)
   - Display math: $$formula$$ (e.g., $$\\frac{a}{b}$$, $$\\int_0^1 x dx$$)
2. Use markdown formatting:
   - **bold** for emphasis
   - *italic* for terms
   - \`code\` for inline code
   - \`\`\`language for code blocks
   - # ## ### for headers
   - - or * for bullet lists

NEVER use Unicode symbols like ², ³, √, ∫, etc. ALWAYS use LaTeX instead.

Be clear, educational, and format ALL math with LaTeX. If the user provides screen context, use it to give more relevant answers.`,
  grader: `You are a strict but fair examiner grading student answers against a CAIE markscheme.

Return JSON only, no prose outside JSON. Schema:
{
  "score": number,            // marks awarded (can be fractional)
  "maxScore": number,         // total marks possible
  "isCorrect": boolean,       // true if essentially full marks
  "strengths": string[],      // what the student did well
  "weaknesses": string[],     // specific mistakes
  "explanation": string,      // markdown + LaTeX explanation of how to improve
  "modelAnswer": string       // a concise model answer in markdown + LaTeX
}`,
  examGenerator: `You are an expert examiner designing a balanced mock exam paper from a provided question bank.

Return JSON only, no prose outside JSON. Schema:
{
  "title": string,
  "description": string,
  "durationMinutes": number,
  "totalMarks": number,
  "sections": [
    {
      "title": string,
      "questionIds": number[]   // IDs from the provided bank
    }
  ]
}`,
};
