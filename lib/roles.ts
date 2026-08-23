/**
 * Who counts as an admin or a moderator.
 *
 * Deliberately dependency-free. These predicates are needed both by
 * `lib/auth.ts` (server guards) and by the NextAuth session callback, and
 * `lib/auth.ts` imports `authOptions` from that route — so putting them in
 * either place makes the import cycle. They are pure functions over
 * `{ role, email }` and belong on their own.
 */

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
 * Roles that may moderate discussion content (hide/pin/lock threads, remove
 * posts) without being full administrators.
 */
const MODERATOR_ROLES = new Set(['teacher']);

/** What the predicates below need: the role column and the address. */
export type RoleBearer = { role?: string | null; email?: string | null } | null;

/**
 * Returns true if the given user (with role + email) is an admin.
 * A user is an admin if EITHER:
 *   - their email is in the ADMIN_EMAILS env-var allowlist (bootstrap), OR
 *   - their role column is "admin" or "super_admin".
 */
export function isAdminUser(user: RoleBearer): boolean {
  if (!user) return false;
  const email = (user.email ?? '').toLowerCase();
  if (email && ADMIN_EMAILS.includes(email)) return true;
  if (user.role && ADMIN_ROLES.has(user.role)) return true;
  return false;
}

/**
 * True if the user may moderate community content.
 *
 * Every admin is a moderator, including bootstrap admins granted via the
 * ADMIN_EMAILS env var — which hand-rolled `user.role === 'admin'` checks
 * previously missed, locking the bootstrap admin out of moderation.
 */
export function isModerator(user: RoleBearer): boolean {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  return Boolean(user.role && MODERATOR_ROLES.has(user.role));
}
