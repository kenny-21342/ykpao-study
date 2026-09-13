import { NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { prisma } from '@/lib/prisma';
import { strictLimiter } from '@/lib/rate-limit';
import { sendVerificationEmail } from '@/lib/email-verification';

export const dynamic = 'force-dynamic';

const Body = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().toLowerCase().email().max(254),
  // Kept in sync with the rules stated on the signup form. Existing accounts
  // with shorter passwords are unaffected — this gates registration only.
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(200, 'Password must be 200 characters or fewer'),
});

/**
 * POST /api/auth/signup — register a new credentials account.
 * Rate-limited per IP to mitigate spam account creation and enumeration.
 */
export async function POST(req: Request) {
  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();
  if (!(await strictLimiter.check(`signup:${ip}`))) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a minute and try again.' },
      { status: 429 }
    );
  }

  const result = Body.safeParse(await req.json().catch(() => null));
  if (!result.success) {
    // Surface one human-readable reason rather than zod's internal issue
    // array, which leaks schema shape and reads as a wall of JSON.
    const first = result.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? 'Please check the details you entered.' },
      { status: 400 }
    );
  }
  const parsed = result.data;

  // Case-insensitive so a legacy mixed-case row can't be shadowed by a
  // second account that differs only in capitalisation.
  const existing = await prisma.user.findFirst({
    where: { email: { equals: parsed.email, mode: 'insensitive' } },
  });
  if (existing) {
    // 409 (not 400) so the form can distinguish "already registered" from a
    // validation failure and offer a sign-in link instead of a dead end.
    return NextResponse.json(
      { error: 'An account with this email already exists.' },
      { status: 409 }
    );
  }

  const hashedPassword = await bcrypt.hash(parsed.password, 12);
  const user = await prisma.user.create({
    data: {
      name: parsed.name,
      email: parsed.email,
      password: hashedPassword,
    },
  });

  // `emailVerified` is left null by the create above, and both sign-in paths
  // refuse a session while it is null — so this mail is the only way into the
  // account that was just made. Awaited rather than fired and forgotten:
  // serverless tears the invocation down at the response, and a floating
  // promise here would be killed mid-flight often enough to look random.
  const emailSent = await sendVerificationEmail(user.email!, user.name);

  return NextResponse.json(
    {
      user: { id: user.id, email: user.email },
      // The form tells the student to go and confirm. When mail is not
      // configured at all there is nothing to wait for, so say so rather than
      // sending them to an inbox that will stay empty.
      emailSent,
    },
    { status: 201 },
  );
}
