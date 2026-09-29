import { DeepSeekMessage, DeepSeekResponse } from '@/types/ai';
import type { TextCredential } from '@/lib/ai-credentials';
import { candidateModels, noteModelOutcome } from '@/lib/ai-model-pool';

/**
 * Provider-agnostic chat client.
 *
 * This module no longer holds a key of its own. Under bring-your-own-key the
 * caller resolves a `TextCredential` per user (lib/ai-credentials.ts) and
 * passes it in, so the endpoint, model and bearer token all vary per request.
 * The shape of the request is the OpenAI-compatible `/chat/completions` one
 * that DeepSeek, SiliconFlow, OpenRouter and most school proxies all speak.
 *
 * The class name `DeepSeekError` is kept — it is the error type every route
 * already catches and re-serialises, and renaming it would touch far more
 * code than it is worth. Its messages are provider-neutral.
 */
export class DeepSeekError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'DeepSeekError';
  }
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

/**
 * Attempts *per model*, including the first. Two is one bounded retry.
 *
 * Distinct from the candidate list in lib/ai-model-pool.ts: `maxAttempts`
 * asks the same model again, which is right for a transient blip, and
 * failover asks a different model, which is right when this one is not being
 * served. Grading passes `maxAttempts: 1` because it fans out -- that must
 * stop it retrying a model, not stop it reaching a working one.
 */
const DEFAULT_MAX_ATTEMPTS = 2;

export type ChatOptions = {
  /**
   * Whose key pays for this call, where to send it, and which model to ask
   * for. Required: there is no ambient server key to fall back to.
   */
  credential: TextCredential;
  temperature?: number;
  maxTokens?: number;
  jsonResponse?: boolean;
  /** Total wall-clock budget for the call, retries and backoff included. */
  budgetMs?: number;
  /** Total attempts, including the first. 1 disables retrying. */
  maxAttempts?: number;
  /** Caller cancellation (e.g. the client disconnected). */
  signal?: AbortSignal;
  /**
   * Called once with the provider's own token counts when a request succeeds
   * and the provider reported usage. Callers that log usage prefer this over
   * estimating from text length; when the endpoint omits `usage` (some proxies
   * do) it is simply never called and the caller keeps its estimate.
   */
  onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
  /**
   * Called with the model that actually answered, which is not always
   * `credential.model` once failover is in play. Callers that record usage
   * should book this rather than the model they asked for, or `/usage` names a
   * model that never ran and the next person to debug a grade is misled.
   */
  onModel?: (model: string) => void;
};

/** Transient upstream conditions worth one more attempt. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function chat(
  messages: DeepSeekMessage[],
  options: ChatOptions
): Promise<string> {
  const {
    credential,
    temperature = 0.7,
    maxTokens = 2000,
    jsonResponse = false,
    budgetMs = DEFAULT_BUDGET_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    signal,
  } = options;

  if (!credential?.apiKey || !credential.endpoint || !credential.model) {
    throw new DeepSeekError(
      'No AI credentials were supplied for this request. Add an API key in Account Settings → AI Provider.',
      503,
    );
  }

  const body: Record<string, unknown> = {
    model: credential.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonResponse) {
    body.response_format = { type: 'json_object' };
  }

  const deadline = Date.now() + Math.max(1_000, budgetMs);
  const attempts = Math.max(1, maxAttempts);
  let lastError: DeepSeekError = new DeepSeekError('The AI request was not attempted', 503);

  // Best first, and a model that recently answered "not being served" sits at
  // the back. For a student's own key this is always exactly one model.
  const candidates = candidateModels(credential);

  candidate: for (let ci = 0; ci < candidates.length; ci++) {
    const model = candidates[ci];
    const moreModels = ci < candidates.length - 1;
    body.model = model;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const remaining = deadline - Date.now();
      // Not enough left to be worth starting: fail with what we know rather
      // than firing a request the platform will kill mid-flight. No later
      // candidate can help either, so stop walking them.
      if (remaining < 1_000) break candidate;

      // Reserve time for another try when one is still available -- whether
      // that is this model again or the next model along.
      const isLastTry = !moreModels && attempt === attempts;
      const attemptMs = isLastTry ? remaining : Math.max(5_000, Math.floor(remaining * 0.6));

      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), attemptMs);

      try {
        const res = await fetch(credential.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${credential.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) {
          // The upstream body can echo back the prompt (which may contain a
          // student's answer) and sometimes account/billing detail. Log it for
          // operators; never let it reach the client, since several routes
          // return `error.message` verbatim.
          const detail = await res.text();
          console.error(
            `AI request failed (${res.status}) [source=${credential.source} model=${model}]:`,
            detail.slice(0, 2000),
          );
          noteModelOutcome(model, res.status);
          lastError = new DeepSeekError(
            res.status === 429
              ? 'The AI service is rate-limited right now. Please try again in a moment.'
              : res.status === 401 || res.status === 403
                ? credential.source === 'user'
                  ? 'Your AI provider rejected your API key (401/403). Check the key and endpoint in Account Settings → AI Provider.'
                  : 'The shared AI key was rejected by the provider. Please tell an administrator.'
                : res.status === 404
                  ? credential.source === 'user'
                    ? `Your AI endpoint returned 404 for model “${model}”. Check the API endpoint and model name in Account Settings → AI Provider.`
                    : 'The AI endpoint returned 404.'
                  : `The AI provider returned an error (${res.status})`,
            res.status
          );
          // A 401/403 is the key, not the model: no candidate will fix it, so
          // fail now rather than spending the budget proving it three times.
          if (res.status === 401 || res.status === 403) throw lastError;
          // Otherwise asking *this* model again is only worth it for the
          // transient statuses. When it is not, another model still might work.
          if (!isRetryableStatus(res.status)) {
            if (moreModels) continue candidate;
            throw lastError;
          }
        } else {
          const data = (await res.json()) as DeepSeekResponse;
          const content = data.choices?.[0]?.message?.content;
          if (content) {
            noteModelOutcome(model, 'ok');
            options.onModel?.(model);
            if (data.usage && options.onUsage) {
              options.onUsage({
                promptTokens: data.usage.prompt_tokens ?? 0,
                completionTokens: data.usage.completion_tokens ?? 0,
              });
            }
            return content;
          }
          lastError = new DeepSeekError('The AI provider returned an empty response', 502);
        }
      } catch (err) {
        if (err instanceof DeepSeekError) throw err;

        // The caller gave up (client disconnected): stop, don't retry.
        if (signal?.aborted) {
          throw new DeepSeekError('The request was cancelled', 499);
        }
        const timedOut = err instanceof Error && err.name === 'AbortError';
        console.error(
          `AI request error [model=${model}]:`,
          timedOut ? `timed out after ${attemptMs}ms` : err,
        );
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

      // Short, bounded backoff — only if there is real time left to use it,
      // and only before asking the same model again. Moving to a different
      // model needs no backoff: this one's trouble is not the next one's.
      const left = deadline - Date.now();
      if (attempt < attempts && left > 3_000) {
        await sleep(Math.min(750 * attempt, left - 2_000));
      }
    }

    // Out of attempts on this model. A rate limit is the one failure that is
    // not worth carrying to the next candidate: the quota belongs to the key,
    // which every candidate shares, so walking the list during a throttle
    // spends the same budget faster and makes the throttle last longer. The
    // bounded retry above, with its backoff, is the right answer to a 429.
    if (lastError.status === 429) break;
  }

  throw lastError;
}

export async function chatJSON<T = unknown>(
  messages: DeepSeekMessage[],
  options: Omit<ChatOptions, 'jsonResponse'>
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
    throw new DeepSeekError('The AI provider did not return valid JSON', 502);
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
  // Deliberately does NOT ask for totalMarks or durationMinutes. The caller
  // knows both: duration comes from the request, and marks are summed from the
  // real question rows after selection, so the model's numbers were discarded
  // on arrival. Asking for them cost output tokens on the one call whose
  // latency was breaking generation, and invited a paper whose stated marks
  // disagreed with its questions.
  examGenerator: `You are an expert examiner choosing questions for a mock exam paper from a provided question bank.

Return JSON only, no prose outside JSON. Schema:
{
  "title": string,
  "description": string,
  "sections": [
    {
      "title": string,
      "questionIds": number[]   // IDs from the provided bank
    }
  ]
}`,
};
