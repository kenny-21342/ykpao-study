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
 * Largest value Postgres accepts in a 32-bit integer column, and the ceiling
 * on anything that reaches `skip`/`take`.
 *
 * Without this, `?page=99999999999999999999` parses to a finite 1e20, survives
 * every `Number.isFinite` check, and fails inside Prisma instead -- a raw
 * driver error surfacing as a 500 on input a user can type.
 */
export const MAX_INT4 = 2_147_483_647;

/**
 * Parse a positive integer from a query parameter.
 *
 * Returns `fallback` when the value is missing, non-numeric, or below 1, and
 * clamps to `max`, which defaults to what the database can actually store.
 * Never returns `NaN`, and never returns something Postgres will reject.
 */
export function parsePositiveInt(
  raw: string | null | undefined,
  fallback: number,
  max: number = MAX_INT4,
): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/**
 * Parse a database row id from a path segment or query parameter.
 *
 * Returns null for anything that is not a positive integer the database could
 * hold, so a handler answers 404 rather than handing an out-of-range value to
 * Prisma and 500ing.
 */
export function parseEntityId(raw: string | null | undefined): number | null {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_INT4) return null;
  return parsed;
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
  const limit = parsePositiveInt(searchParams.get('limit'), defaultLimit, maxLimit);
  // Clamp the page so `skip` itself stays in range: a page number that fits in
  // an int4 can still multiply out past it.
  const maxPage = Math.max(1, Math.floor(MAX_INT4 / limit));
  const page = parsePositiveInt(searchParams.get('page'), 1, maxPage);
  return { page, limit, skip: (page - 1) * limit };
}
