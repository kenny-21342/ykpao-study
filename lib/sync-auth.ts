import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { prisma } from '@/lib/prisma';
import crypto from 'node:crypto';

/**
 * Auth helper for sync endpoints.
 *
 * Accepts EITHER:
 *   - a valid NextAuth session (web browser), OR
 *   - an `Authorization: Bearer <token>` header (iPad / external client)
 *
 * Returns the User record on success, or null if unauthenticated.
 *
 * The Bearer token is sha256-hashed and compared against `user.syncToken`,
 * so the plaintext token never lives in the DB.
 */
export async function getSyncUser(req?: Request): Promise<{
  id: string;
  email: string;
  name: string | null;
} | null> {
  // ---- 1. Try Bearer token ----
  const authHeader = req?.headers?.get('authorization');
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    const plaintext = authHeader.slice(7).trim();
    if (plaintext.length > 0) {
      const hashed = crypto.createHash('sha256').update(plaintext).digest('hex');
      const user = await prisma.user.findFirst({
        where: { syncToken: hashed, banned: false },
        select: { id: true, email: true, name: true },
      });
      if (user) return user;
    }
  }

  // ---- 2. Fall back to NextAuth session ----
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return null;
  return prisma.user.findUnique({
    where: { email: session.user.email },
    select: { id: true, email: true, name: true },
  });
}
