import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { rateLimit } from '@/lib/rate-limit';
import { appOrigin, isEmailConfigured, sendEmail } from '@/lib/email';

/**
 * Email verification for self-service signup.
 *
 * WHY NOW — signup created a working account for any string shaped like an
 * address, real or not. That was tolerable while the only accounts were people
 * the owner knew personally. It stops being tolerable the moment the platform
 * opens to a year group: without verification there is no way to tell a
 * student's address from a typo or from someone signing up as somebody else,
 * password reset has nothing trustworthy to send to, and the one channel for
 * telling a student anything is unreliable by construction.
 *
 * STORAGE — the same `VerificationToken` table `lib/password-reset.ts` reuses,
 * for the same reason: no migration. The baseline migration hand-creates a
 * generated `searchVector` column and three `gin_trgm_ops` indexes that Prisma
 * reports as drift and offers to DROP, so every avoided `migrate dev` is an
 * avoided chance to break AI study search.
 *
 * NAMESPACING — `identifier` carries a `verify:` prefix. There are now three
 * kinds of row in that table: NextAuth's own (bare address), password resets
 * (`pwreset:`) and these. Redemption filters on the prefix in every case, so a
 * token minted for one purpose can never be redeemed as another — a
 * verification link must not be usable to set a password.
 */

/** Identifier namespace. Everything this module writes carries it. */
export const VERIFY_PREFIX = 'verify:';

/**
 * How long a link stays valid.
 *
 * Longer than a password reset's hour, deliberately. A reset token is a live
 * key to an existing account and should expire before a forwarded mail can be
 * abused; a verification token only proves the mailbox exists, and a student
 * who signs up at school and opens the mail that evening should not have to
 * start again.
 */
export const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** 256 bits of CSPRNG output, matching the reset tokens. */
const TOKEN_BYTES = 32;

/**
 * Resend limits. Lower than the reset limiters because this endpoint is
 * reachable by anyone who can sign up, and each call sends mail.
 */
export const verifyResendIpLimiter = rateLimit({ intervalMs: 15 * 60_000, max: 5 });
export const verifyResendEmailLimiter = rateLimit({ intervalMs: 60 * 60_000, max: 3 });

/** Guards redemption, which does a DB lookup and a write per call. */
export const verifyConfirmIpLimiter = rateLimit({ intervalMs: 15 * 60_000, max: 20 });

/** Lowercased and trimmed, matching how signup stores addresses. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Only the hash is stored; the plaintext exists solely in the emailed link.
 * sha256 rather than bcrypt because the input is 256 bits we generated
 * ourselves, not a human-chosen password — there is no dictionary to slow an
 * attacker down against.
 */
function hashToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Mint a verification token and return the plaintext exactly once.
 *
 * Outstanding tokens for the same address are retired first, so asking for a
 * second mail invalidates the first link rather than leaving two live.
 */
export async function issueVerificationToken(email: string): Promise<string> {
  const identifier = VERIFY_PREFIX + normalizeEmail(email);
  const plaintext = crypto.randomBytes(TOKEN_BYTES).toString('base64url');

  await prisma.verificationToken.deleteMany({ where: { identifier } });
  await prisma.verificationToken.create({
    data: {
      identifier,
      token: hashToken(plaintext),
      expires: new Date(Date.now() + VERIFY_TOKEN_TTL_MS),
    },
  });

  return plaintext;
}

/**
 * Redeem a token, returning the address it was minted for, or `null`.
 *
 * Single use is enforced by the delete rather than a flag: the row is removed
 * as the act of claiming it, and `delete` on a unique key either removes
 * exactly one row or throws, so two concurrent redemptions cannot both win.
 * An expired token is still consumed — it has no further use, and deleting it
 * keeps the table from accumulating dead links.
 */
export async function consumeVerificationToken(plaintext: string): Promise<string | null> {
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

  // A password-reset token must not be redeemable as a verification, and vice
  // versa, even though both live in this table.
  if (!row.identifier.startsWith(VERIFY_PREFIX)) return null;
  if (row.expires.getTime() <= Date.now()) return null;

  return row.identifier.slice(VERIFY_PREFIX.length);
}

/** The link a new student clicks. */
export function verifyUrl(plaintextToken: string): string {
  return `${appOrigin()}/auth/verify?token=${encodeURIComponent(plaintextToken)}`;
}

/** The welcome message, which is also the verification mail. */
export function verifyEmailBody(link: string, name?: string | null): {
  subject: string;
  text: string;
  html: string;
} {
  const hours = Math.round(VERIFY_TOKEN_TTL_MS / (60 * 60_000));
  const greeting = name?.trim() ? `Hi ${name.trim()},` : 'Hi,';
  return {
    subject: 'Confirm your email for YKPao Study',
    text: [
      greeting,
      '',
      'Thanks for signing up to YKPao Study. Confirm this address to finish',
      `setting up your account (the link expires in ${hours} hours):`,
      link,
      '',
      "If you didn't sign up, you can ignore this email — no account will be used.",
    ].join('\n'),
    html: `
      <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111827">
        <h1 style="font-size:20px;margin:0 0 16px">Confirm your email</h1>
        <p style="margin:0 0 16px;line-height:1.6">${greeting.replace(/,$/, '')} — thanks for signing up to YKPao Study. Confirm this address to finish setting up your account.</p>
        <p style="margin:0 0 24px">
          <a href="${link}" style="display:inline-block;background:#10b981;color:#fff;text-decoration:none;padding:12px 24px;border-radius:12px;font-weight:600">Confirm my email</a>
        </p>
        <p style="margin:0 0 16px;line-height:1.6;color:#4b5563;font-size:14px">
          This link expires in ${hours} hours and can only be used once.
        </p>
        <p style="margin:0;line-height:1.6;color:#4b5563;font-size:14px">
          If you didn't sign up, you can ignore this email — no account will be used.
        </p>
      </div>`,
  };
}

/**
 * Mint a token and send the confirmation mail. Returns whether it went out.
 *
 * Never throws. A signup must not fail because Resend is down or unconfigured
 * — the account is already created at that point, and a 500 would leave the
 * student staring at an error next to a working account they cannot reach.
 * The caller tells them to check their mail either way; if it never arrives,
 * the resend endpoint is the way back.
 */
export async function sendVerificationEmail(
  email: string,
  name?: string | null,
): Promise<boolean> {
  if (!isEmailConfigured()) return false;
  try {
    const token = await issueVerificationToken(email);
    await sendEmail({ to: email, ...verifyEmailBody(verifyUrl(token), name) });
    return true;
  } catch (err) {
    console.error('[email-verification] send failed', err);
    return false;
  }
}
