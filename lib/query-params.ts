/**
 * Helpers for reading numeric query-string parameters.
 *
 * The naive idiom `Math.max(1, parseInt(raw, 10))` looks safe but is not:
 * `parseInt('abc', 10)` is `NaN`, and every arithmetic clamp preserves `NaN`
 * (`Math.max(1, NaN) === NaN`). The bad value then reaches Prisma's `skip`/
 * `take` — or, in the case of /api/step, gets interpolated straight into raw
 * SQL — and the request 500s. Route handlers should use these instead.
 */

/**
 * Parse a positive integer from a query parameter.
 *
 * Returns `fallback` when the value is missing, non-numeric, or below 1, and
 * clamps to `max` when one is given. Never returns `NaN`.
 */
export function parsePositiveInt(
  raw: string | null | undefined,
  fallback: number,
  max?: number,
): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max === undefined ? parsed : Math.min(parsed, max);
}

/**
 * Read `page` and `limit` from a URL's search params as a Prisma-ready
 * `{ page, limit, skip }`, with `limit` capped so a caller cannot ask for the
 * entire table with `?limit=999999`.
 */
export function parsePagination(
  searchParams: URLSearchParams,
  opts: { defaultLimit?: number; maxLimit?: number } = {},
): { page: number; limit: number; skip: number } {
  const { defaultLimit = 20, maxLimit = 100 } = opts;
  const page = parsePositiveInt(searchParams.get('page'), 1);
  const limit = parsePositiveInt(searchParams.get('limit'), defaultLimit, maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}
