import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, isAdminUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';
import { parsePositiveInt } from '@/lib/query-params';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/users?q=&role=&sort=&page=&pageSize=
 * List/search users with pagination.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.trim() ?? '';
  const role = searchParams.get('role')?.trim();
  const sort = searchParams.get('sort') ?? 'createdAt';
  const page = parsePositiveInt(searchParams.get('page'), 1);
  const pageSize = parsePositiveInt(searchParams.get('pageSize'), 20, 100);

  const where: Record<string, unknown> = {};
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
    ];
  }
  if (role && role !== 'all') where.role = role;

  const sortMap: Record<string, string> = {
    createdAt: 'createdAt',
    email: 'email',
    name: 'name',
  };
  const sortField = sortMap[sort.replace('-', '')] ?? 'createdAt';
  const sortOrder = sort.startsWith('-') ? 'desc' : 'asc';

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: {
        id: true, name: true, email: true, image: true, role: true,
        banned: true, bannedReason: true, createdAt: true, onboardedAt: true,
        emailVerified: true,
        _count: {
          select: {
            notes: true, threads: true, posts: true,
            mockExams: true, pastPaperAttempts: true, usageRecords: true,
            schoolResources: true,
          },
        },
      },
      orderBy: { [sortField]: sortOrder },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.user.count({ where }),
  ]);

  // Decorate with the effective-admin flag (env-var allowlist OR role).
  const decorated = users.map((u) => ({
    ...u,
    effectiveAdmin: isAdminUser({ role: u.role, email: u.email }),
  }));

  return NextResponse.json({ users: decorated, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
}

const updateSchema = z.object({
  role: z.enum(['student', 'teacher', 'admin']).optional(),
  banned: z.boolean().optional(),
  // Explicit null clears the column — the UI sends bannedReason: null when it
  // unbans. A plain z.string() rejected that, so the ban itself could never
  // be revoked and every unban attempt surfaced as "Invalid request".
  bannedReason: z.string().max(500).nullable().optional(),
  /**
   * Manual override for the signup verification gate.
   *
   * WHY THIS EXISTS — mail is the single point of failure in self-registration
   * and it is not fully under our control: verification mail currently lands in
   * Gmail's Junk, and a student who never finds it is locked out of an account
   * that otherwise works. Without this the only recovery is an admin running
   * UPDATE against production by hand, which is a far worse thing to need at
   * nine in the morning on a school day.
   *
   * `false` is accepted as well as `true` so a mis-click is recoverable in the
   * same UI rather than needing the SQL this exists to avoid.
   */
  emailVerified: z.boolean().optional(),
});

/**
 * PATCH /api/admin/users
 * Bulk or single update. Body: { userId, role?, banned?, bannedReason? }
 */
export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success || !body?.userId) {
    return NextResponse.json({ error: 'Invalid request', issues: parsed.error?.issues }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id: body.userId }, select: { id: true, email: true, role: true } });
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  // Prevent self-demotion / self-ban so the admin never locks themselves out.
  if (target.id === admin.id) {
    return NextResponse.json({ error: 'You cannot modify your own account.' }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.role !== undefined) data.role = parsed.data.role;
  if (parsed.data.banned !== undefined) data.banned = parsed.data.banned;
  if (parsed.data.bannedReason !== undefined) data.bannedReason = parsed.data.bannedReason;
  // The column is a timestamp, not a flag — the gate in the credentials
  // `authorize` callback only checks truthiness, so the value is the record of
  // when it was granted rather than something the sign-in path reads.
  if (parsed.data.emailVerified !== undefined) {
    data.emailVerified = parsed.data.emailVerified ? new Date() : null;
  }

  const updated = await prisma.user.update({ where: { id: body.userId }, data, select: { id: true, role: true, banned: true, bannedReason: true, emailVerified: true } });
  return NextResponse.json({ user: updated });
}

/**
 * DELETE /api/admin/users?userId=
 * Delete a user and cascade all their content.
 */
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  if (target.id === admin.id) {
    return NextResponse.json({ error: 'You cannot delete your own account.' }, { status: 400 });
  }

  await prisma.user.delete({ where: { id: userId } });
  return NextResponse.json({ success: true });
}
