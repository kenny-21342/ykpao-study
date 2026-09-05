/**
 * Keep every request on one origin.
 *
 * Three hostnames serve this app -- the custom domain and two `.vercel.app`
 * aliases -- while `NEXTAUTH_URL` names only one of them. OAuth cannot survive
 * that: signing in from an alias sets the `state` and PKCE cookies on the
 * alias, but Google is handed a `redirect_uri` on the canonical host, so the
 * callback arrives at an origin where those cookies do not exist and is
 * rejected. The student sees a failed login with no explanation.
 *
 * Redirecting to the canonical origin before anything else runs makes the
 * alias a way in rather than a broken path.
 */

/**
 * Paths served on whatever hostname asked for them.
 *
 * Vercel Cron invokes a deployment on its own `.vercel.app` hostname and does
 * not follow redirects, so a 308 to the canonical origin does not reroute the
 * job -- it cancels it. That is not hypothetical: `/api/cron/backup` fired at
 * 19:07 nightly, took the redirect, and never ran. The bucket went from 24 Aug
 * to 5 Sep holding one scheduled snapshot, which was actually a manual one.
 *
 * Exempting these is safe because the OAuth problem above cannot apply. A cron
 * route carries no session and reads no cookie; it authenticates on the
 * `Authorization: Bearer $CRON_SECRET` header, which is origin-independent.
 */
const HOST_AGNOSTIC_PREFIXES = ['/api/cron/'];

/**
 * The redirect target for a request, or `null` to let it through.
 *
 * @param requestUrl  Absolute URL of the incoming request.
 * @param canonicalOrigin  e.g. `https://study.busypizza.bond`. When empty or
 *   unparseable, nothing is redirected: an unset `NEXTAUTH_URL` must not take
 *   the site down.
 */
export function canonicalRedirectUrl(
  requestUrl: string,
  canonicalOrigin: string | undefined,
): string | null {
  if (!canonicalOrigin) return null;

  let canonical: URL;
  let incoming: URL;
  try {
    canonical = new URL(canonicalOrigin);
    incoming = new URL(requestUrl);
  } catch {
    return null;
  }

  // Host, not origin: a proxy may terminate TLS and forward as http, and
  // redirecting on scheme alone would loop.
  if (incoming.host === canonical.host) return null;

  if (HOST_AGNOSTIC_PREFIXES.some((prefix) => incoming.pathname.startsWith(prefix))) {
    return null;
  }

  const target = new URL(incoming.pathname + incoming.search, canonical.origin);
  return target.toString();
}
