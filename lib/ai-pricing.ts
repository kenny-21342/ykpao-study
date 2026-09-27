/**
 * Per-model price estimates for the Usage dashboard.
 *
 * Prices are USD per million tokens, input and output listed separately, and
 * they are estimates for reporting only — the provider's invoice is the
 * authority, and a provider that reprices will make this table drift until it
 * is updated. Anything not named here falls back to DEFAULT.
 *
 * The shared key now serves a New API gateway carrying models from eight
 * vendors, none of them priced here yet, so every shared call is currently
 * estimated at DEFAULT. That is reporting drift rather than a spend risk --
 * the monthly cap reserves a flat amount per request and does not read this
 * table -- but /usage will not be trustworthy until the gateway's own price
 * list is transcribed into the table below.
 */
/**
 * Models the shared key serves at no cost — currently none.
 *
 * This held OpenCode Zen's free tier until 27 Sep 2026. That plan did not
 * survive contact with the provider: OpenCode allows its free models only
 * inside its own client, so they were never usable from here. The shared key
 * now points at a New API gateway whose models all draw down real credit.
 *
 * Left in place rather than deleted, because `isFreeModel` is what
 * `sharedModelIsFree` reads, and that is what decides whether the monthly
 * per-user spend cap applies. Empty is the correct value and the safe one: it
 * means the cap applies to every shared call, which with open access is the
 * only thing bounding what a whole year group can spend. Adding a model here
 * switches that protection off for it, so add one only when it is genuinely
 * billed at zero.
 */
export const FREE_MODELS: readonly string[] = [];

/** Whether a model costs nothing, so no spend control should apply to it. */
export function isFreeModel(model: string | undefined): boolean {
  return FREE_MODELS.includes((model ?? '').trim());
}

type ModelPrice = { inPerMTok: number; outPerMTok: number };

const PRICES: Array<{ match: RegExp; price: ModelPrice }> = [
  // api.deepseek.com list pricing, per 1M tokens.
  { match: /^deepseek-reasoner/, price: { inPerMTok: 0.55, outPerMTok: 2.19 } },
  { match: /^deepseek-chat/, price: { inPerMTok: 0.27, outPerMTok: 1.1 } },

  // SiliconFlow list pricing, per 1M tokens. These are the two models the
  // shared key actually serves in production, and neither was priced here
  // before: a provider prefixes its model names (`deepseek-ai/…`, `Qwen/…`),
  // so the two anchored patterns above could never match them and every call
  // fell through to DEFAULT. Every DeepSeek row in `usage_records` is
  // consequently mispriced.
  //
  // The figures match the extraction pipeline's own constants in
  // `pdf_extraction/bank/run.py:55-59`, so a transcription run costed offline
  // and the same run read off /usage agree rather than quietly differing.
  { match: /qwen3-vl/, price: { inPerMTok: 0.28, outPerMTok: 1.13 } },
  { match: /^deepseek-ai\//, price: { inPerMTok: 0.27, outPerMTok: 1.1 } },

  // Anything in FREE_MODELS, priced at $0. That list is empty today, so this
  // contributes nothing -- kept because it is what makes adding a genuinely
  // free model a one-line change in one place rather than two edits that can
  // disagree. A model in FREE_MODELS but not priced here would be reported at
  // DEFAULT on /usage while also skipping the spend cap: billed in the UI,
  // unbilled in reality, which is the worst of both.
  ...FREE_MODELS.map((model) => ({
    match: new RegExp(`^${model}$`),
    price: { inPerMTok: 0, outPerMTok: 0 },
  })),
];

const DEFAULT: ModelPrice = { inPerMTok: 0.3, outPerMTok: 1.2 };

/**
 * Estimated USD cost of one completion, rounded to a millionth so a float
 * column never accumulates arithmetic noise across rows.
 */
export function estimateCostUsd(
  model: string | undefined,
  tokensIn: number,
  tokensOut: number,
): number {
  const entry = PRICES.find(({ match }) => match.test((model ?? '').toLowerCase()));
  const price = entry?.price ?? DEFAULT;
  const cost =
    (Math.max(0, tokensIn) / 1_000_000) * price.inPerMTok +
    (Math.max(0, tokensOut) / 1_000_000) * price.outPerMTok;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
