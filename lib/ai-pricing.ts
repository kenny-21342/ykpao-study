import { SHARED_MODEL_CHOICES } from './shared-models.ts';

/**
 * Per-model price estimates for the Usage dashboard.
 *
 * Prices are USD per million tokens, input and output listed separately, and
 * they are estimates for reporting only — the provider's invoice is the
 * authority, and a provider that reprices will make this table drift until it
 * is updated. Anything not named here falls back to DEFAULT, chosen near the
 * DeepSeek text models the shared key serves: a wrong estimate on an unknown
 * bring-your-own-key model should be boring, not surprising.
 */
/**
 * Models the shared key may serve at no cost — the ids of everything a student
 * can pick in the tutor. `lib/shared-models.ts` is the list itself and records
 * each model's data-retention terms and why two free ones are excluded.
 *
 * Derived rather than restated, because the two must not drift: a model
 * offered in the picker but missing here would be priced at DEFAULT below,
 * which bills a free service and re-imposes the monthly cap on it.
 *
 * Every one is promotional and time-limited. When one is withdrawn the
 * provider answers with an unknown-model error, so treat a sudden rise in AI
 * errors as this list going stale before assuming anything else.
 */
export const FREE_MODELS = SHARED_MODEL_CHOICES.map((choice) => choice.id);

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

  // OpenCode Zen's free tier, which the shared key serves from 27 Sep 2026.
  // Listed at $0, so they must be named here: an unlisted model falls through
  // to DEFAULT below and would bill a free service at $0.30/$1.20 per Mtok --
  // fiction on /usage, and worse than fiction in `reserveMonthlyAiSpend`,
  // which would cut every student off at the monthly cap for spending nothing.
  //
  // `FREE_MODELS` rather than one loose pattern: these are individually-named
  // promotional models that expire, and a regex like /-free$/ would silently
  // price a future paid model at zero.
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
