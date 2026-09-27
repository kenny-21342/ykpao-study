import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, isAdminUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isSharedAiConfigured, isSharedAiOpenToAll } from '@/lib/ai-credentials';
import { parsePositiveInt } from '@/lib/query-params';
import { readSharedAiBudget } from '@/lib/rate-limit';

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

/**
 * GET /api/admin/ai-access?q=&granted=&page=&pageSize=
 *
 * Two things at once, because the console screen needs both:
 *  - `grants`: every account that currently holds a grant, regardless of the
 *    search filter, so the admin can always see the full liability.
 *  - `users`: one searchable, paginated page of the directory decorated with
 *    its grant state, since the school has far too many students to render in
 *    one list.
 *
 * No secret is read here. `encryptedApiKey` is selected only to derive a
 * `hasOwnKey` boolean and is never returned.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim() ?? '';
  const grantedOnly = searchParams.get('granted') === '1';
  const page = parsePositiveInt(searchParams.get('page'), 1);
  const pageSize = parsePositiveInt(searchParams.get('pageSize'), 20, 100);

  const where: Record<string, unknown> = {};
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (grantedOnly) where.aiCredential = { is: { sharedKeyAccess: true } };

  const credentialSelect = {
    sharedKeyAccess: true,
    sharedKeyGrantedAt: true,
    sharedKeyGrantedBy: true,
    // Presence of a personal key only — never the key, never the hint's
    // source. Admins get to see that a student is self-sufficient, nothing
    // more.
    encryptedApiKey: true,
    textModel: true,
  } as const;

  const [rows, users, total, sharedBudget] = await Promise.all([
    prisma.userAiCredential.findMany({
      where: { sharedKeyAccess: true },
      select: { userId: true, ...credentialSelect, user: { select: { name: true, email: true } } },
      orderBy: { sharedKeyGrantedAt: 'desc' },
    }),
    prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
        banned: true,
        createdAt: true,
        aiCredential: { select: credentialSelect },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.user.count({ where }),
    // What is left of the platform-wide ceiling. Shown here rather than on a
    // page of its own because this is where an admin already comes to ask who
    // is spending the shared key -- and with the per-user cap off, this number
    // is the only thing standing between a year group and the credit behind
    // it. It must not first become visible on the day it runs out.
    readSharedAiBudget(),
  ]);

  return NextResponse.json({
    sharedKeyConfigured: isSharedAiConfigured(),
    // Whether the per-account grants below are still the gate at all.
    // With `SHARED_AI_OPEN_TO_ALL` on, every signed-in account reaches the
    // shared key regardless of this list, which makes the list read as a
    // complete picture when it is not. There was no way to tell from inside
    // the app which mode was live -- an admin looking at a short grants list
    // could reasonably conclude only those users had AI.
    sharedKeyOpenToAll: isSharedAiOpenToAll(),
    sharedBudget,
    grants: rows.map((row) => ({
      userId: row.userId,
      name: row.user.name,
      email: row.user.email,
      grantedAt: row.sharedKeyGrantedAt,
      grantedBy: row.sharedKeyGrantedBy,
      hasOwnKey: Boolean(row.encryptedApiKey),
    })),
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
      role: u.role,
      banned: u.banned,
      createdAt: u.createdAt,
      effectiveAdmin: isAdminUser({ role: u.role, email: u.email }),
      sharedKeyAccess: Boolean(u.aiCredential?.sharedKeyAccess),
      grantedAt: u.aiCredential?.sharedKeyGrantedAt ?? null,
      grantedBy: u.aiCredential?.sharedKeyGrantedBy ?? null,
      hasOwnKey: Boolean(u.aiCredential?.encryptedApiKey),
      textModel: u.aiCredential?.textModel ?? null,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
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
          'There is no shared server key configured (SHARED_AI_API_KEY), so a grant would do nothing.',
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
