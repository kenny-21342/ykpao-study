import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { isEmailConfigured, sendEmail } from '@/lib/email';
import {
  issueResetToken,
  normalizeEmail,
  oauthOnlyEmailBody,
  resetEmailBody,
  resetRequestEmailLimiter,
  resetRequestIpLimiter,
  resetUrl,
} from '@/lib/password-reset';

export const dynamic = 'force-dynamic';

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

/**
 * The one and only success payload.
 *
 * THIS IS THE SECURITY PROPERTY: the response is byte-identical whether the
 * address belongs to a student, to nobody, to a banned account, or to someone
 * who signs in with Google. A school roster is a small, guessable namespace —
 * an endpoint that answered "no such account" would let anyone confirm which
 * classmates have accounts, one address at a time.
 */
const UNIFORM_RESPONSE = {
  ok: true,
  message:
    'If that email belongs to an account, a password reset link is on its way. Check your inbox and spam folder.',
} as const;

/**
 * POST /api/auth/forgot-password — request a reset link.
 *
 * Every branch below either returns UNIFORM_RESPONSE or returns a failure that
 * is independent of whether the address exists. Read it with that invariant in
 * mind: any new `return` that fires only for real accounts is a bug, however
 * helpful its message is.
 */
export async function POST(req: Request) {
  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();

  if (!(await resetRequestIpLimiter.check(`pwreset-req-ip:${ip}`))) {
    return NextResponse.json(
      { error: 'Too many reset requests. Please wait a few minutes and try again.' },
      { status: 429 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // Malformed input, not a missing account: this fires for "not an email"
    // regardless of what exists, so it is not an oracle.
    return NextResponse.json(
      { error: 'Please enter a valid email address.' },
      { status: 400 },
    );
  }
  const email = normalizeEmail(parsed.data.email);

  // Checked BEFORE the user lookup, deliberately. If this ran after, a deploy
  // with no API key would answer 503 for real accounts and 200 for unknown
  // ones — the misconfiguration itself would become the enumeration oracle.
  if (!isEmailConfigured()) {
    console.error(
      '[forgot-password] RESEND_API_KEY is not set — password reset is disabled. ' +
        'See .env.example.',
    );
    return NextResponse.json(
      {
        error:
          'Password reset is temporarily unavailable. Please contact a teacher or administrator.',
      },
      { status: 503 },
    );
  }

  // Keyed on the submitted address, not on a resolved user, so the limit
  // applies identically to addresses that do not exist.
  if (!(await resetRequestEmailLimiter.check(`pwreset-req-email:${email}`))) {
    return NextResponse.json(
      { error: 'Too many reset requests for this address. Please try again later.' },
      { status: 429 },
    );
  }

  // Case-insensitive for the same reason sign-in is: legacy rows predate
  // address normalisation.
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, email: true, password: true, banned: true },
  });

  try {
    if (user && !user.banned) {
      if (user.password) {
        const token = await issueResetToken(user.email);
        await sendEmail({ to: user.email, ...resetEmailBody(resetUrl(token)) });
      } else {
        // OAuth-only account. No token is minted — see oauthOnlyEmailBody for
        // why we still send something.
        await sendEmail({ to: user.email, ...oauthOnlyEmailBody() });
      }
    }
    // No account, or a banned one: nothing happens, and the caller cannot tell.
  } catch (error) {
    // A delivery failure can only occur when the address *does* exist, so
    // surfacing it would re-introduce the oracle this endpoint exists to
    // avoid. Log loudly for the operator and stay uniform for the caller.
    // The likeliest cause — no API key at all — is already caught above with
    // an honest 503, so this path is a genuine Resend-side problem.
    console.error('[forgot-password] delivery failed:', error);
  }

  return NextResponse.json(UNIFORM_RESPONSE, { status: 200 });
}
