import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { prisma } from '@/lib/prisma';
import {
  PWRESET_PREFIX,
  consumeResetToken,
  normalizeEmail,
  resetConfirmIpLimiter,
} from '@/lib/password-reset';

export const dynamic = 'force-dynamic';

const Body = z.object({
  token: z.string().min(1).max(500),
  // Kept in sync with the signup form and /api/account.
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(200, 'Password must be 200 characters or fewer'),
});

/**
 * One message for every way a link can fail to work: wrong, already used,
 * expired, or belonging to an account that has since been banned or deleted.
 * Distinguishing them would tell an attacker holding a guessed token which
 * guesses were structurally interesting.
 */
const INVALID_TOKEN = 'This reset link is invalid or has expired. Please request a new one.';

/**
 * POST /api/auth/reset-password — redeem a link and set a new password.
 */
export async function POST(req: Request) {
  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();

  if (!(await resetConfirmIpLimiter.check(`pwreset-confirm-ip:${ip}`))) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a few minutes and try again.' },
      { status: 429 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? 'Please check the details you entered.' },
      { status: 400 },
    );
  }

  // Validate the new password BEFORE consuming the token. Redeeming first
  // would burn the student's only link on a typo and force them back through
  // the whole email round trip.
  const { token, password } = parsed.data;

  // Single use: this deletes the row, so a replay of the same link lands here
  // and gets null.
  const email = await consumeResetToken(token);
  if (!email) {
    return NextResponse.json({ error: INVALID_TOKEN }, { status: 400 });
  }

  const user = await prisma.user.findFirst({
    where: { email: { equals: normalizeEmail(email), mode: 'insensitive' } },
    select: { id: true, banned: true, password: true },
  });

  // The token was consumed above regardless — a link for a deleted or banned
  // account is spent, not left live.
  if (!user || user.banned) {
    return NextResponse.json({ error: INVALID_TOKEN }, { status: 400 });
  }

  // Tokens are never minted for password-less accounts, so this is defensive:
  // it stops a reset link from quietly converting a Google account into a
  // credentials account if that invariant is ever broken upstream.
  if (!user.password) {
    return NextResponse.json({ error: INVALID_TOKEN }, { status: 400 });
  }

  const hashed = await bcrypt.hash(password, 12);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashed,
        // The iPad sync bearer token (lib/sync-auth.ts) is a second, long-lived
        // credential that bypasses the session entirely. A reset is a claim
        // that the account may be compromised, so it has to go too — the
        // student re-pairs the iPad from the account page.
        syncToken: null,
      },
    }),
    // Sessions are stateless JWTs, so these rows are not what keeps anyone
    // signed in — changing `password` is, because it changes the credential
    // fingerprint every issued token carries (lib/password-reset.ts,
    // getSessionUser in lib/auth.ts). This delete is here so the adapter's
    // table cannot hold stale rows for the account, and so the revocation
    // stays correct if the session strategy is ever switched to "database".
    prisma.session.deleteMany({ where: { userId: user.id } }),
    // Retire any other outstanding links for this address.
    prisma.verificationToken.deleteMany({
      where: { identifier: PWRESET_PREFIX + normalizeEmail(email) },
    }),
  ]);

  console.info(`[password-reset] password reset completed for user ${user.id}`);

  return NextResponse.json({
    ok: true,
    message: 'Your password has been changed. You can now sign in.',
  });
}
