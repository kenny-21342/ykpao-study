import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Security and correctness properties of signup email verification.
 *
 * Same approach as tests/password-reset.test.ts, and for the same reason:
 * `lib/email-verification.ts` imports `@/lib/prisma` at module scope, which
 * plain node resolves to neither an alias nor a database. So mirror the
 * decision the implementation makes, assert the property on the mirror, and
 * separately pin the source so the mirror cannot drift.
 *
 * The properties being defended, worst failure first:
 *   1. Nobody who existed before this shipped is locked out. A retroactive
 *      gate with no backfill bricks every real account at once, silently,
 *      with no way back in -- this is the only failure here that cannot be
 *      recovered from the browser.
 *   2. A verification token cannot be redeemed as a password reset. Both live
 *      in one table; without the prefix filter, a confirmation link would be a
 *      password-change link.
 *   3. Confirmation links work exactly once.
 *   4. Only a hash of the token is stored.
 *   5. Neither the resend endpoint nor the redeem endpoint reveals which
 *      addresses have accounts. This is a school roster.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relative: string) => readFile(join(root, relative), 'utf8');

/** Comments stripped, so prose explaining a rule can't satisfy the rule. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*');
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Mirrors of the implementation
// ---------------------------------------------------------------------------

const VERIFY_PREFIX = 'verify:';
const PWRESET_PREFIX = 'pwreset:';
const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const hashToken = (plaintext: string) =>
  crypto.createHash('sha256').update(plaintext).digest('hex');

type StoredToken = { identifier: string; token: string; expires: number };

/** In-memory `verification_tokens`, with Prisma's delete-or-throw semantics. */
class TokenStore {
  private rows = new Map<string, StoredToken>();

  deleteMany(identifier: string): void {
    for (const [key, row] of this.rows) {
      if (row.identifier === identifier) this.rows.delete(key);
    }
  }

  create(row: StoredToken): void {
    if (this.rows.has(row.token)) throw new Error('unique constraint violation on token');
    this.rows.set(row.token, row);
  }

  delete(token: string): StoredToken {
    const row = this.rows.get(token);
    if (!row) throw new Error('P2025: record to delete does not exist');
    this.rows.delete(token);
    return row;
  }

  get size(): number {
    return this.rows.size;
  }
}

/** Mirror of issueVerificationToken(). */
function issueVerificationToken(store: TokenStore, email: string, now = Date.now()): string {
  const identifier = VERIFY_PREFIX + email.trim().toLowerCase();
  const plaintext = crypto.randomBytes(32).toString('base64url');
  store.deleteMany(identifier);
  store.create({ identifier, token: hashToken(plaintext), expires: now + VERIFY_TOKEN_TTL_MS });
  return plaintext;
}

/** Mirror of consumeVerificationToken(). */
function consumeVerificationToken(
  store: TokenStore,
  plaintext: string,
  now = Date.now(),
): string | null {
  if (!plaintext) return null;
  let row: StoredToken;
  try {
    row = store.delete(hashToken(plaintext));
  } catch {
    return null;
  }
  if (!row.identifier.startsWith(VERIFY_PREFIX)) return null;
  if (row.expires <= now) return null;
  return row.identifier.slice(VERIFY_PREFIX.length);
}

// ---------------------------------------------------------------------------
// 1. Nobody existing is locked out
// ---------------------------------------------------------------------------

test('a migration grandfathers every account that predates the gate', async () => {
  const sql = await readSource(
    'prisma/migrations/20260913120000_grandfather_email_verification/migration.sql',
  );

  // The whole point: every pre-existing row, with no WHERE clause narrowing it
  // to some subset of users, and no date cutoff to drift out of step.
  assert.match(sql, /UPDATE\s+"users"\s+SET\s+"emailVerified"\s*=\s*NOW\(\)/i);
  assert.match(sql, /WHERE\s+"emailVerified"\s+IS\s+NULL/i);

  // A schema change here would risk the known Prisma drift on the generated
  // searchVector column; this must stay a pure data migration.
  assert.doesNotMatch(sql, /\b(ALTER|CREATE|DROP)\b/i);
});

test('the sign-in gate reads the column the migration fills', async () => {
  const src = stripComments(await readSource('app/api/auth/[...nextauth]/route.ts'));
  assert.match(src, /if \(!user\.emailVerified\)/);
  assert.match(src, /throw new Error\("EmailUnverified"\)/);
});

test('the unverified check runs only after the password is proven', async () => {
  const src = stripComments(await readSource('app/api/auth/[...nextauth]/route.ts'));
  const passwordChecked = src.indexOf('if (!isPasswordValid)');
  const verifyChecked = src.indexOf('if (!user.emailVerified)');

  assert.ok(passwordChecked > 0 && verifyChecked > 0);
  assert.ok(
    verifyChecked > passwordChecked,
    'answering before the password is checked turns sign-in into an oracle for which addresses have accounts',
  );
});

test('Google accounts are stamped verified rather than gated', async () => {
  const src = await readSource('app/api/auth/[...nextauth]/route.ts');
  // The adapter never writes this column, so without the stamp an OAuth user
  // sits at null forever and any future read-time gate locks them all out.
  assert.match(src, /if \(!dbUser\.emailVerified\)/);
  assert.match(src, /data: \{ emailVerified: new Date\(\) \}/);
});

// ---------------------------------------------------------------------------
// 2. A verification token is not a password-reset token
// ---------------------------------------------------------------------------

test('a password-reset token cannot be redeemed as a verification', () => {
  const store = new TokenStore();
  const plaintext = crypto.randomBytes(32).toString('base64url');
  // A reset token, minted into the same table.
  store.create({
    identifier: PWRESET_PREFIX + 'student@example.com',
    token: hashToken(plaintext),
    expires: Date.now() + 60 * 60 * 1000,
  });

  assert.equal(consumeVerificationToken(store, plaintext), null);
});

test("NextAuth's own bare-address tokens cannot be redeemed either", () => {
  const store = new TokenStore();
  const plaintext = crypto.randomBytes(32).toString('base64url');
  store.create({
    identifier: 'student@example.com',
    token: hashToken(plaintext),
    expires: Date.now() + 60 * 60 * 1000,
  });

  assert.equal(consumeVerificationToken(store, plaintext), null);
});

test('the implementation really filters on its own prefix', async () => {
  const src = stripComments(await readSource('lib/email-verification.ts'));
  assert.match(src, /VERIFY_PREFIX = 'verify:'/);
  assert.match(src, /startsWith\(VERIFY_PREFIX\)/);
  assert.match(src, /slice\(VERIFY_PREFIX\.length\)/);
});

// ---------------------------------------------------------------------------
// 3. Single use, and expiry
// ---------------------------------------------------------------------------

test('a confirmation link works exactly once', () => {
  const store = new TokenStore();
  const token = issueVerificationToken(store, 'student@example.com');

  assert.equal(consumeVerificationToken(store, token), 'student@example.com');
  assert.equal(consumeVerificationToken(store, token), null, 'a replayed link must not work');
  assert.equal(store.size, 0);
});

test('asking for a second link retires the first', () => {
  const store = new TokenStore();
  const first = issueVerificationToken(store, 'student@example.com');
  const second = issueVerificationToken(store, 'student@example.com');

  assert.equal(store.size, 1, 'only one link may be live at a time');
  assert.equal(consumeVerificationToken(store, first), null);
  assert.equal(consumeVerificationToken(store, second), 'student@example.com');
});

test('an expired link is refused, and is spent rather than left lying around', () => {
  const store = new TokenStore();
  const issuedAt = Date.now();
  const token = issueVerificationToken(store, 'student@example.com', issuedAt);

  const afterExpiry = issuedAt + VERIFY_TOKEN_TTL_MS + 1;
  assert.equal(consumeVerificationToken(store, token, afterExpiry), null);
  assert.equal(store.size, 0, 'a dead token should not accumulate in the table');
});

test('links last a day, not an hour — a reset TTL would be wrong here', async () => {
  const src = await readSource('lib/email-verification.ts');
  assert.match(src, /VERIFY_TOKEN_TTL_MS = 24 \* 60 \* 60 \* 1000/);
});

// ---------------------------------------------------------------------------
// 4. Only a hash is stored
// ---------------------------------------------------------------------------

test('the emailed token is never what gets stored', () => {
  const store = new TokenStore();
  const plaintext = issueVerificationToken(store, 'student@example.com');

  assert.doesNotMatch(
    JSON.stringify(store),
    new RegExp(plaintext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.equal(hashToken(plaintext).length, 64);
});

test('lib/email-verification.ts really hashes before storing, with 32 bytes of entropy', async () => {
  const src = stripComments(await readSource('lib/email-verification.ts'));
  assert.match(src, /TOKEN_BYTES = 32/);
  assert.match(src, /createHash\('sha256'\)/);
  assert.match(src, /token: hashToken\(plaintext\)/);
  // The plaintext must reach the caller and nothing else.
  assert.doesNotMatch(src, /token: plaintext/);
});

// ---------------------------------------------------------------------------
// 5. Neither endpoint enumerates the roster
// ---------------------------------------------------------------------------

test('the resend endpoint answers the same way for every address', async () => {
  const src = stripComments(await readSource('app/api/auth/verify/resend/route.ts'));

  // One shared message constant, used for the hit, the miss, and the
  // per-address rate limit alike — a distinct answer on any of those three is
  // the oracle.
  assert.match(src, /const SENT =/);
  assert.doesNotMatch(src, /no account/i);
  assert.doesNotMatch(src, /not found/i);
  assert.doesNotMatch(src, /already verified/i);

  // The lookup result may only gate whether mail is sent, never the response.
  assert.match(src, /return NextResponse\.json\(\{ message: SENT \}\)/);
});

test('the resend endpoint is rate limited per address as well as per IP', async () => {
  const src = stripComments(await readSource('app/api/auth/verify/resend/route.ts'));
  assert.match(src, /verifyResendIpLimiter/);
  assert.match(src, /verifyResendEmailLimiter/);
});

test('redeeming reports one failure for every way a link can fail', async () => {
  const src = stripComments(await readSource('app/api/auth/verify/route.ts'));
  assert.match(src, /const INVALID_TOKEN =/);
  assert.doesNotMatch(src, /already used/i);
  assert.doesNotMatch(src, /no account/i);

  // Already-confirmed is a success: the common cause is a second click, and
  // an error would send the student round the loop for nothing.
  assert.match(src, /if \(!user\.emailVerified\)/);
  assert.match(src, /return NextResponse\.json\(\{ ok: true \}\)/);
});

// ---------------------------------------------------------------------------
// 6. Signup stays usable when mail fails
// ---------------------------------------------------------------------------

test('a send failure never fails the signup', async () => {
  const src = stripComments(await readSource('lib/email-verification.ts'));
  const fn = src.slice(src.indexOf('export async function sendVerificationEmail'));

  assert.match(fn, /if \(!isEmailConfigured\(\)\) return false/);
  assert.match(fn, /catch/);
  assert.match(fn, /return false/);
});

test('signup awaits the send rather than floating it', async () => {
  const src = stripComments(await readSource('app/api/auth/signup/route.ts'));
  // A floating promise is killed when the serverless invocation is torn down
  // at the response, so the mail would go out only sometimes.
  assert.match(src, /await sendVerificationEmail\(/);
  assert.match(src, /emailSent/);
});

test('the signup form stops trying to sign the new account straight in', async () => {
  const src = stripComments(await readSource('app/auth/signup/page.tsx'));
  // The credentials provider now refuses an unverified account, so the old
  // auto sign-in would fail every time and read as a broken signup.
  assert.doesNotMatch(src, /signIn\('credentials'/);
  assert.match(src, /setCreated\(/);
});

// ---------------------------------------------------------------------------
// 7. The manual recovery route
// ---------------------------------------------------------------------------
//
// Mail is the single point of failure in self-registration and it is not fully
// under our control — verification mail currently lands in Gmail's Junk. The
// admin override is what stops "the mail never arrived" from requiring an
// UPDATE against production by hand.

test('an admin can set and clear verification through the users API', async () => {
  const src = stripComments(await readSource('app/api/admin/users/route.ts'));

  // Both directions, so a mis-click is recoverable in the same UI.
  assert.match(src, /emailVerified: z\.boolean\(\)\.optional\(\)/);

  // The column is a timestamp. Assigning the boolean straight through would
  // be a type error today, but the mapping is the part worth pinning: `false`
  // must clear the column, not stamp a date.
  assert.match(src, /emailVerified\s*\?\s*new Date\(\)\s*:\s*null/);

  // Without this the list cannot show who is stuck, which is the only way an
  // admin finds out there is anyone to rescue.
  assert.match(src, /emailVerified: true,/);
});

test('granting verification is confirmed, not one click', async () => {
  const src = stripComments(await readSource('app/admin/sections/UserManagement.tsx'));
  const fn = src.slice(src.indexOf('const toggleVerified'), src.indexOf('const resetPassword'));

  assert.match(fn, /await confirm\(/);
  assert.match(fn, /if \(!ok\) return/);
  // The PATCH must not be reachable before the dialog resolves.
  assert.ok(
    fn.indexOf('if (!ok) return') < fn.indexOf('adminFetch'),
    'the confirmation must gate the request, not follow it',
  );
});
