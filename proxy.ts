import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { canonicalRedirectUrl } from '@/lib/canonical-host';

/**
 * Send every production request to the single origin `NEXTAUTH_URL` names.
 *
 * See lib/canonical-host.ts for why: OAuth breaks when the sign-in starts on
 * one hostname and the callback arrives on another.
 *
 * Production only. Preview deployments each get their own hostname, and
 * bouncing them to production would make previews impossible to use.
 *
 * (In Next 16 this file is `proxy.ts`; `middleware.ts` is the deprecated name
 * for the same convention.)
 */
export function proxy(request: NextRequest) {
  // A NUL byte has no legitimate use in a URL, and Postgres rejects one that
  // reaches a text column -- `?pageId=%00` surfaced as an unhandled 500 with a
  // raw driver message. Refusing it once here beats sanitising every string
  // parameter in every handler.
  if (request.nextUrl.pathname.includes('\0') || request.nextUrl.search.includes('\0')) {
    return NextResponse.json({ error: 'Malformed request' }, { status: 400 });
  }

  if (process.env.VERCEL_ENV !== 'production') return NextResponse.next();

  const target = canonicalRedirectUrl(request.url, process.env.NEXTAUTH_URL);
  if (!target) return NextResponse.next();

  // 308 rather than 302: permanent, and it preserves the method, so a POST
  // that lands on an alias is not silently downgraded to a GET.
  return NextResponse.redirect(target, 308);
}

export const config = {
  /**
   * Everything except Next's own static output and the favicon. Those are
   * fetched from whatever origin served the page, so redirecting them would
   * add a round trip to every asset for no benefit.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
