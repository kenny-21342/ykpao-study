import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import {
  consumeVerificationToken,
  verifyConfirmIpLimiter,
} from '@/lib/email-verification';

export const dynamic = 'force-dynamic';

const Body = z.object({
  token: z.string().min(1).max(500),
});

/**
 * One message for every way a link can fail: wrong, already spent, expired, or
 * belonging to an account since deleted or banned. Telling them apart would
 * tell someone holding a guessed token which guesses were interesting.
 */
const INVALID_TOKEN =
  'This confirmation link is invalid or has expired. Request a new one below.';

/**
 * POST /api/auth/verify — redeem a confirmation link.
 *
 * Deliberately a POST, not a GET on the link itself. Mail clients and security
 * scanners prefetch links; a GET that verified would be spent before the
 * student ever opened the message. The page at /auth/verify reads the token
 * from the URL and posts it.
 */
export async function POST(req: Request) {
  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();

  if (!(await verifyConfirmIpLimiter.check(`verify-confirm-ip:${ip}`))) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a few minutes and try again.' },
      { status: 429 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: INVALID_TOKEN }, { status: 400 });
  }

  // Single use: this deletes the row, so a replayed link lands here with null.
  const email = await consumeVerificationToken(parsed.data.token);
  if (!email) {
    return NextResponse.json({ error: INVALID_TOKEN }, { status: 400 });
  }

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, banned: true, emailVerified: true },
  });

  // The token is spent either way — a link for a deleted or banned account is
  // burnt, not left live.
  if (!user || user.banned) {
    return NextResponse.json({ error: INVALID_TOKEN }, { status: 400 });
  }

  // Already verified is a success, not an error: the usual cause is a student
  // clicking the link twice, and telling them it failed would send them round
  // the loop again for nothing.
  if (!user.emailVerified) {
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: new Date() },
    });
  }

  return NextResponse.json({ ok: true });
}
