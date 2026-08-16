import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { strictLimiter } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

/**
 * iPad / external-client auth bridge.
 *
 * POST /api/auth/token
 *   { email, password }
 *
 * Validates against the same bcrypt-hashed password the NextAuth credentials
 * provider uses, then mints (or returns the existing) long-lived opaque
 * bearer token stored on the user. The iPad sends this token as
 * `Authorization: Bearer <token>` on subsequent sync requests.
 *
 * Returns:
 *   200 { token, userId, name, email }
 *   401 { error: "Invalid credentials" }
 *   400 { error: "<validation message>" }
 *
 * Security notes:
 *   - Token is a 32-byte crypto.randomBytes string (URL-safe base64).
 *   - Stored hashed (sha256) on the user row, so a DB leak doesn't expose
 *     live tokens. The plaintext is returned exactly once at login.
 *   - Rotate by calling POST again with `rotate: true`.
 */

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  rotate: z.boolean().optional(),
});

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export async function POST(req: NextRequest) {
  // Password verification must be rate-limited, or this endpoint is an
  // unmetered oracle for credential stuffing against every account.
  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();
  if (!(await strictLimiter.check(`token:${ip}`))) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a minute and try again.' },
      { status: 429 }
    );
  }

  let parsed;
  try {
    parsed = LoginBody.parse(await req.json());
  } catch {
    // Zod's message is a JSON blob of internal issues — never surface it.
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  // Also limit per-account, so a distributed attacker cannot spread attempts
  // against one victim across many source addresses.
  if (!(await strictLimiter.check(`token-account:${parsed.email.toLowerCase()}`))) {
    return NextResponse.json(
      { error: 'Too many attempts. Please wait a minute and try again.' },
      { status: 429 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { email: parsed.email.toLowerCase() },
    select: { id: true, name: true, email: true, password: true, banned: true, syncToken: true },
  });

  // Always run a bcrypt compare even on missing user to equalise timing.
  const passwordHash = user?.password ?? '$2b$10$oooooooooooooooooooooooooooooooooooooooooooooooooooooo';
  const passwordOk = user
    ? await bcrypt.compare(parsed.password, passwordHash)
    : await bcrypt.compare(parsed.password, passwordHash);

  if (!user || !passwordOk) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }
  if (user.banned) {
    return NextResponse.json({ error: 'Account suspended' }, { status: 403 });
  }

  // Reuse existing token unless rotation requested.
  if (user.syncToken && !parsed.rotate) {
    return NextResponse.json({
      token: null, // we can't return a hashed token — caller must rotate
      tokenHashed: true,
      userId: user.id,
      name: user.name,
      email: user.email,
      message: 'A sync token already exists. Re-login with rotate: true to get a new plaintext token.',
    });
  }

  // Mint a fresh token, store its hash.
  const plaintext = newToken();
  await prisma.user.update({
    where: { id: user.id },
    data: { syncToken: hashToken(plaintext) },
  });

  return NextResponse.json({
    token: plaintext,
    userId: user.id,
    name: user.name,
    email: user.email,
  });
}
