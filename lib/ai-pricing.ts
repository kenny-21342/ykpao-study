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
type ModelPrice = { inPerMTok: number; outPerMTok: number };

const PRICES: Array<{ match: RegExp; price: ModelPrice }> = [
  // api.deepseek.com list pricing, per 1M tokens.
  { match: /^deepseek-reasoner/, price: { inPerMTok: 0.55, outPerMTok: 2.19 } },
  { match: /^deepseek-chat/, price: { inPerMTok: 0.27, outPerMTok: 1.1 } },
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
