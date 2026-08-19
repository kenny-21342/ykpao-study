import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { rateLimit } from '@/lib/rate-limit';
import { appOrigin } from '@/lib/email';

/**
 * Self-service password reset: token issuing, single-use redemption, and the
 * claim that lets a reset invalidate sessions issued before it.
 *
 * STORAGE — this reuses the existing `VerificationToken` table
 * (`{ identifier, token @unique, expires }`) rather than adding a model, so
 * the feature ships with no migration. That matters here: the baseline
 * migration hand-creates a generated `searchVector` column and three
 * `gin_trgm_ops` indexes that Prisma reports as drift and offers to DROP, so
 * every avoided `migrate dev` is an avoided chance to break AI study search.
 *
 * NAMESPACING — `identifier` is prefixed with `pwreset:` so these rows can
 * never be confused with (or redeemed as) NextAuth's own email-verification
 * tokens, which use the bare address as the identifier. Redemption filters on
 * the prefix, so a token minted for another purpose cannot reset a password.
 */

/** Identifier namespace. Everything this module writes carries it. */
export const PWRESET_PREFIX = 'pwreset:';

/**
 * How long a link stays valid. Short, because the token is sitting in an
 * inbox: the window in which a stolen or forwarded mail is useful should be
 * measured in minutes.
 */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/** 256 bits of CSPRNG output. Not guessable, so brute force is not a threat
 *  model the rate limiter has to carry on its own. */
const TOKEN_BYTES = 32;

/**
 * Request side. Five per 15 minutes per IP, and three per hour for any one
 * address — keyed on what the client *submitted*, never on whether it
 * resolved to an account, so the limiter cannot itself answer "does this user
 * exist?".
 */
export const resetRequestIpLimiter = rateLimit({ intervalMs: 15 * 60_000, max: 5 });
export const resetRequestEmailLimiter = rateLimit({ intervalMs: 60 * 60_000, max: 3 });

/**
 * Confirm side. Guards the redemption endpoint, which does a DB lookup and a
 * bcrypt hash per call.
 */
export const resetConfirmIpLimiter = rateLimit({ intervalMs: 15 * 60_000, max: 10 });

/** Lowercased and trimmed, matching how signup stores addresses. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * What actually goes in the database.
 *
 * The plaintext token exists only in the emailed link. Anyone who can read the
 * `verification_tokens` table — a leaked backup, a SQL-injection read, an
 * over-broad support query — gets hashes they cannot reverse into working
 * links. sha256 rather than bcrypt because the input is 256 bits of entropy we
 * generated ourselves, not a human-chosen password: there is no dictionary to
 * slow an attacker down against.
 */
function hashToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Mint a reset token for an address and return the plaintext exactly once.
 *
 * Any outstanding tokens for the same address are deleted first, so requesting
 * a second link silently retires the first. Without that, every request a
 * student makes while hunting through their inbox leaves another live key to
 * the account.
 */
export async function issueResetToken(email: string): Promise<string> {
  const identifier = PWRESET_PREFIX + normalizeEmail(email);
  const plaintext = crypto.randomBytes(TOKEN_BYTES).toString('base64url');

  await prisma.verificationToken.deleteMany({ where: { identifier } });
  await prisma.verificationToken.create({
    data: {
      identifier,
      token: hashToken(plaintext),
      expires: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  return plaintext;
}

/**
 * Redeem a token, returning the address it was minted for, or `null`.
 *
 * SINGLE USE is enforced by the delete, not by a flag: the row is removed as
 * the act of claiming it, and `delete` on a unique key either deletes exactly
 * one row or throws. Two concurrent redemptions of the same token therefore
 * cannot both win — the loser gets P2025 and is told the link is invalid. A
 * read-then-update pair would let both through.
 *
 * The token is consumed even when expired: an expired row has no further use,
 * and deleting it keeps the table from accumulating dead links.
 */
export async function consumeResetToken(plaintext: string): Promise<string | null> {
  if (!plaintext) return null;

  let row: { identifier: string; expires: Date };
  try {
    row = await prisma.verificationToken.delete({
      where: { token: hashToken(plaintext) },
      select: { identifier: true, expires: true },
    });
  } catch {
    // Not found, or lost the race to a concurrent redemption.
    return null;
  }

  // A token minted for email verification must not be redeemable as a
  // password reset, even though both live in this table.
  if (!row.identifier.startsWith(PWRESET_PREFIX)) return null;
  if (row.expires.getTime() <= Date.now()) return null;

  return row.identifier.slice(PWRESET_PREFIX.length);
}

/**
 * Binds a session to the credential that created it.
 *
 * WHY THIS EXISTS — sessions here are stateless JWTs (`session.strategy:
 * 'jwt'` in the NextAuth options). The `sessions` table the Prisma adapter
 * creates is therefore never read: deleting rows from it revokes nothing, and
 * there is no server-side record of an issued session to invalidate. Nor can
 * we key off the token's own `iat`, because NextAuth re-encodes the JWT with a
 * fresh `iat` on every `/api/auth/session` read — a stolen cookie would
 * refresh itself past any cutoff.
 *
 * So the token carries a fingerprint of the password hash it was issued
 * against, and `getSessionUser()` re-derives that fingerprint from the current
 * row on every request. Change the password and every previously issued token
 * stops matching — which is exactly "resetting a password signs out every
 * other device", with no schema change and no extra query, because the user
 * row is already being fetched there.
 *
 * It is an HMAC rather than a plain hash because the value is exposed on the
 * client's session object. Keyed with the NextAuth secret, it is opaque to
 * anyone who cannot already forge sessions, and it reveals nothing about the
 * password hash it covers.
 */
export function credentialFingerprint(passwordHash: string | null | undefined): string {
  const secret =
    process.env.NEXTAUTH_SECRET ||
    process.env.AUTH_SECRET ||
    // Only reachable in development; production boot fails without a secret.
    'insecure-development-fallback';

  return crypto
    .createHmac('sha256', secret)
    // The empty string is a legitimate input: OAuth-only accounts have no
    // password, and their fingerprint must be stable rather than random.
    .update(passwordHash ?? '')
    .digest('hex')
    .slice(0, 32);
}

/** The link a student clicks. */
export function resetUrl(plaintextToken: string): string {
  return `${appOrigin()}/auth/reset-password?token=${encodeURIComponent(plaintextToken)}`;
}

/** Message body for an account that has a password to reset. */
export function resetEmailBody(link: string): { subject: string; text: string; html: string } {
  const minutes = Math.round(RESET_TOKEN_TTL_MS / 60_000);
  return {
    subject: 'Reset your YKPao Study password',
    text: [
      'We received a request to reset the password for your YKPao Study account.',
      '',
      `Open this link to choose a new password (it expires in ${minutes} minutes and can only be used once):`,
      link,
      '',
      "If you didn't ask for this, you can ignore this email — your password has not changed.",
    ].join('\n'),
    html: `
      <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111827">
        <h1 style="font-size:20px;margin:0 0 16px">Reset your password</h1>
        <p style="margin:0 0 16px;line-height:1.6">We received a request to reset the password for your YKPao Study account.</p>
        <p style="margin:0 0 24px">
          <a href="${link}" style="display:inline-block;background:#10b981;color:#fff;text-decoration:none;padding:12px 24px;border-radius:12px;font-weight:600">Choose a new password</a>
        </p>
        <p style="margin:0 0 16px;line-height:1.6;color:#4b5563;font-size:14px">
          This link expires in ${minutes} minutes and can only be used once.
        </p>
        <p style="margin:0;line-height:1.6;color:#4b5563;font-size:14px">
          If you didn't ask for this, you can ignore this email — your password has not changed.
        </p>
      </div>`,
  };
}

/**
 * Message body for an account that signs in with Google and has no password.
 *
 * Sending this — rather than nothing — is what keeps the flow honest. The HTTP
 * response is identical in every case, so the endpoint leaks nothing; the
 * explanation goes to the mailbox, which only the account's owner can read.
 * Staying silent instead would leave that student waiting for a mail that is
 * never coming, and the owner fielding the support request personally, which
 * is the exact situation this feature exists to end.
 */
export function oauthOnlyEmailBody(): { subject: string; text: string; html: string } {
  const signIn = `${appOrigin()}/auth/login`;
  return {
    subject: 'Signing in to YKPao Study',
    text: [
      'We received a request to reset the password for your YKPao Study account.',
      '',
      "That account doesn't have a password — it signs in with Google. Use the",
      '"Continue with Google" button on the sign-in page instead:',
      signIn,
      '',
      "If you didn't ask for this, you can ignore this email — nothing has changed.",
    ].join('\n'),
    html: `
      <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111827">
        <h1 style="font-size:20px;margin:0 0 16px">You sign in with Google</h1>
        <p style="margin:0 0 16px;line-height:1.6">
          We received a request to reset the password for your YKPao Study account, but
          that account doesn't have a password — it signs in with Google.
        </p>
        <p style="margin:0 0 24px">
          <a href="${signIn}" style="display:inline-block;background:#10b981;color:#fff;text-decoration:none;padding:12px 24px;border-radius:12px;font-weight:600">Go to sign in</a>
        </p>
        <p style="margin:0;line-height:1.6;color:#4b5563;font-size:14px">
          If you didn't ask for this, you can ignore this email — nothing has changed.
        </p>
      </div>`,
  };
}
