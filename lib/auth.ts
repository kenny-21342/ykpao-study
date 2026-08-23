import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { prisma } from '@/lib/prisma';
import { credentialFingerprint } from '@/lib/password-reset';
// Re-exported so existing `@/lib/auth` importers are unaffected; the
// definitions moved to break an import cycle with the NextAuth route.
import { isAdminUser, isModerator } from '@/lib/roles';
export { isAdminUser, isModerator };

/**
 * The authenticated user for the current request, or `null`.
 *
 * Banned users resolve to `null`: a ban has to revoke access everywhere, not
 * just in the admin console. Because sessions are JWTs, a ban cannot be
 * enforced by invalidating the token — it has to be checked on read, here,
 * which is the single chokepoint every authenticated route goes through.
 *
 * A password change is revoked the same way, and for the same reason. The
 * session carries `cfp`, a fingerprint of the password hash it was issued
 * against; re-deriving it from the row we have just fetched costs nothing
 * extra and tells us whether the credential has moved underneath the token.
 * See lib/password-reset.ts for why a JWT cannot be revoked any other way.
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

  // Sessions issued before this mechanism existed have no `cfp` at all. Those
  // are grandfathered rather than force-signed-out: the NextAuth jwt callback
  // backfills one on the token's next read, and from then on the session is
  // revocable. (They also expire on their own within the 30-day JWT maxAge.)
  const issuedAgainst = session.user.cfp;
  if (issuedAgainst !== undefined && issuedAgainst !== credentialFingerprint(user.password)) {
    // The password has changed since this token was issued — a reset, an
    // admin reset, or a self-service change. Whichever it was, this device is
    // no longer holding a current credential.
    return null;
  }

  return user;
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
