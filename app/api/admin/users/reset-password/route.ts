import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

/**
 * Admin-triggered password reset.
 *
 * Until this existed there was no recovery path of any kind: no forgot-password
 * flow, no reset token, no mail transport, and `/api/account` requires the
 * *current* password to set a new one. A student who forgot their password was
 * permanently locked out and nobody — including an admin — could help.
 *
 * This deliberately does not send email (the deployment has no mail provider).
 * It generates a temporary password, returns it to the admin exactly once, and
 * the admin passes it to the student in person or over the school's own
 * channel. That fits a single known cohort; a public deployment should replace
 * this with an emailed single-use token.
 */

// Ambiguity-free alphabet: no O/0, I/l/1, so a password read aloud or copied
// off a sticky note doesn't fail on a character the student can't distinguish.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const TEMP_PASSWORD_LENGTH = 14;

function generateTemporaryPassword(): string {
  let out = '';
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) {
    // randomInt is CSPRNG-backed; Math.random would be predictable.
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}

const bodySchema = z.object({
  userId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  }

  const target = await prisma.user.findUnique({
    where: { id: parsed.data.userId },
    select: { id: true, email: true, name: true, password: true },
  });
  if (!target) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // An OAuth-only account has no password to reset; overwriting one would
  // silently convert it into a credentials account.
  if (!target.password) {
    return NextResponse.json(
      {
        error:
          'This account signs in with an external provider and has no password to reset.',
      },
      { status: 400 }
    );
  }

  const temporaryPassword = generateTemporaryPassword();
  await prisma.user.update({
    where: { id: target.id },
    data: { password: await bcrypt.hash(temporaryPassword, 12) },
  });

  console.info(
    `[admin] password reset for user ${target.id} by admin ${admin.id}`
  );

  return NextResponse.json({
    // Shown to the admin once and never stored in plaintext.
    temporaryPassword,
    email: target.email,
    // Sessions are stateless JWTs, but each one carries a fingerprint of the
    // password hash it was issued against, and getSessionUser() re-checks it
    // on every request — so changing the hash above signs every existing
    // device out. See lib/password-reset.ts.
    existingSessionsRevoked: true,
  });
}
