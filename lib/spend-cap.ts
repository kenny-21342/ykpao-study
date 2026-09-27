/**
 * Whether the monthly per-user AI spend ceiling is switched off.
 *
 * Its own module, importing nothing, so the plain-node test runner can load it
 * — `lib/rate-limit.ts` cannot be imported there because it pulls in Prisma
 * through the `@/lib` alias, which is why the rest of its behaviour is pinned
 * by reading the source instead. This is a policy decision rather than
 * plumbing, so it is worth being able to test properly.
 */

/**
 * Turned off only when someone explicitly says so.
 *
 * An explicit word rather than a very large number, because the two read
 * completely differently to whoever finds this next: `off` is a decision,
 * `999999` is indistinguishable from a typo.
 *
 * The invariant that matters is what happens when the variable is *absent*.
 * `lib/rate-limit.ts` still falls back to a real $5 ceiling in that case, and
 * `tests/ai-spend-cap.test.ts` pins it — losing the value must never be the
 * same as turning the cap off.
 */
export function isMonthlyCapDisabled(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'off' || value === '0' || value === 'none' || value === 'unlimited';
}
