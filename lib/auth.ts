import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { prisma } from '@/lib/prisma';

/**
 * The authenticated user for the current request, or `null`.
 *
 * Banned users resolve to `null`: a ban has to revoke access everywhere, not
 * just in the admin console. Because sessions are JWTs, a ban cannot be
 * enforced by invalidating the token — it has to be checked on read, here,
 * which is the single chokepoint every authenticated route goes through.
 */
export async function getSessionUser() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) return null;

  // Matched verbatim, not lowercased: this address came from the session,
  // which was populated from the DB row itself. Normalising here would fail
  // to find OAuth users whose provider supplied a mixed-case address.
  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
  });
  if (!user || user.banned) return null;

  return user;
}

/**
 * Comma-separated list of email addresses that always have admin rights,
 * regardless of their DB role column. Set via ADMIN_EMAILS env var.
 *
 * Example: ADMIN_EMAILS="alice@example.com,bob@example.com"
 *
 * This is the bootstrap mechanism: set your email here and you instantly
 * have admin access without needing to touch the database. The DB role
 * column is used for granting admin to *other* people via the admin UI.
 */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/** Set of roles that count as an administrator. */
const ADMIN_ROLES = new Set(['admin', 'super_admin']);

/**
 * Returns true if the given user (with role + email) is an admin.
 * A user is an admin if EITHER:
 *   - their email is in the ADMIN_EMAILS env-var allowlist (bootstrap), OR
 *   - their role column is "admin" or "super_admin".
 */
export function isAdminUser(user: { role?: string | null; email?: string | null } | null): boolean {
  if (!user) return false;
  const email = (user.email ?? '').toLowerCase();
  if (email && ADMIN_EMAILS.includes(email)) return true;
  if (user.role && ADMIN_ROLES.has(user.role)) return true;
  return false;
}

/**
 * Roles that may moderate discussion content (hide/pin/lock threads, remove
 * posts) without being full administrators.
 */
const MODERATOR_ROLES = new Set(['teacher']);

/**
 * True if the user may moderate community content.
 *
 * Every admin is a moderator, including bootstrap admins granted via the
 * ADMIN_EMAILS env var — which hand-rolled `user.role === 'admin'` checks
 * previously missed, locking the bootstrap admin out of moderation.
 */
export function isModerator(user: { role?: string | null; email?: string | null } | null): boolean {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  return Boolean(user.role && MODERATOR_ROLES.has(user.role));
}

/**
 * Server-side guard for admin-only route handlers / server components.
 *
 * Returns the authenticated admin User, or `null` if the caller is not
 * authorized (not signed in, banned, or not an admin).
 *
 * Usage in a route handler:
 *   const user = await requireAdmin();
 *   if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
 *
 * Usage in a server component:
 *   const user = await requireAdmin();
 *   if (!user) redirect('/?admin=forbidden');
 */
export async function requireAdmin() {
  const user = await getSessionUser();
  if (!user) return null;
  if (user.banned) return null;
  if (!isAdminUser(user)) return null;
  return user;
}

