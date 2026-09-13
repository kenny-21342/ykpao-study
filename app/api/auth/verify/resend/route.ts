import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import {
  sendVerificationEmail,
  verifyResendEmailLimiter,
  verifyResendIpLimiter,
} from '@/lib/email-verification';

export const dynamic = 'force-dynamic';

const Body = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

/**
 * Said whatever happens, so this endpoint cannot be used to ask which
 * addresses have accounts — the same reason /api/auth/forgot-password answers
 * the same way for everyone.
 */
const SENT = 'If that address has an account awaiting confirmation, a new link is on its way.';

/**
 * POST /api/auth/verify/resend — send another confirmation link.
 *
 * The way back in for a student whose first mail never arrived, went to spam,
 * or expired. Issuing a new token retires the old one (see
 * `issueVerificationToken`), so there is never more than one live link.
 */
export async function POST(req: Request) {
  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();

  if (!(await verifyResendIpLimiter.check(`verify-resend-ip:${ip}`))) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait a few minutes and try again.' },
      { status: 429 },
    );
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 });
  }
  const email = parsed.data.email;

  // Per-address as well as per-IP, so one host cannot mail-bomb a single
  // student's inbox from a rotating pool of addresses.
  if (!(await verifyResendEmailLimiter.check(`verify-resend-email:${email}`))) {
    // Still the neutral message: a distinct 429 here would confirm the account
    // exists, which is exactly what the neutral message is protecting.
    return NextResponse.json({ message: SENT });
  }

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { name: true, email: true, banned: true, emailVerified: true, password: true },
  });

  // Send only to an account that can actually act on the link: unbanned,
  // unverified, and a credentials account. A Google user is verified by the
  // provider and has nothing to confirm.
  if (user?.email && !user.banned && !user.emailVerified && user.password) {
    await sendVerificationEmail(user.email, user.name);
  }

  return NextResponse.json({ message: SENT });
}
