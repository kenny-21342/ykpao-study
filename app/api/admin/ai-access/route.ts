import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isSharedAiConfigured } from '@/lib/ai-credentials';

export const dynamic = 'force-dynamic';

/**
 * Admin control over the one exception to bring-your-own-key: granting a
 * specific account use of the owner's shared server key.
 *
 * This is for demos and for students who genuinely cannot obtain a key. It is
 * deliberately per-account and never a default — every granted account spends
 * the owner's money, which is why that path keeps the monthly spend cap while
 * a user's own key does not.
 *
 * No secret is read or written here. A grant is a boolean; the shared key
 * itself lives only in the server environment.
 */

const Body = z.object({
  userId: z.string().min(1).max(100),
  granted: z.boolean(),
});

/** GET /api/admin/ai-access — who currently holds a grant. */
export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const rows = await prisma.userAiCredential.findMany({
    where: { sharedKeyAccess: true },
    select: {
      userId: true,
      sharedKeyGrantedAt: true,
      sharedKeyGrantedBy: true,
      // Presence of a personal key only — never the key, never the hint's
      // source. Admins get to see that a student is self-sufficient, nothing
      // more.
      encryptedApiKey: true,
      user: { select: { name: true, email: true } },
    },
    orderBy: { sharedKeyGrantedAt: 'desc' },
  });

  return NextResponse.json({
    sharedKeyConfigured: isSharedAiConfigured(),
    grants: rows.map((row) => ({
      userId: row.userId,
      name: row.user.name,
      email: row.user.email,
      grantedAt: row.sharedKeyGrantedAt,
      grantedBy: row.sharedKeyGrantedBy,
      hasOwnKey: Boolean(row.encryptedApiKey),
    })),
  });
}

/** POST /api/admin/ai-access — grant or revoke shared-key access. */
export async function POST(req: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid request' },
      { status: 400 },
    );
  }

  const target = await prisma.user.findUnique({
    where: { id: body.userId },
    select: { id: true, email: true },
  });
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  if (body.granted && !isSharedAiConfigured()) {
    return NextResponse.json(
      {
        error:
          'There is no shared server key configured (DEEPSEEK_API_KEY), so a grant would do nothing.',
      },
      { status: 409 },
    );
  }

  const grantFields = body.granted
    ? {
        sharedKeyAccess: true,
        sharedKeyGrantedBy: admin.email,
        sharedKeyGrantedAt: new Date(),
      }
    : { sharedKeyAccess: false, sharedKeyGrantedBy: null, sharedKeyGrantedAt: null };

  await prisma.userAiCredential.upsert({
    where: { userId: target.id },
    create: { userId: target.id, ...grantFields },
    update: grantFields,
  });

  return NextResponse.json({ ok: true, userId: target.id, granted: body.granted });
}
