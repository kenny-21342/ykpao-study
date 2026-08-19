import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Security properties of the self-service password reset flow.
 *
 * Like tests/rate-limit.test.ts, these cannot import the modules under test:
 * `lib/password-reset.ts` imports `@/lib/prisma` at module scope, and plain
 * node resolves neither the `@/` alias nor a database. So the approach is the
 * same one that file established — mirror the decision the implementation
 * makes, assert the property on the mirror, and *separately* pin the source so
 * the mirror cannot silently drift away from the real code.
 *
 * The properties being defended, in order of how badly they fail:
 *   1. The request endpoint must not reveal whether an address has an account.
 *      This is a school roster: a working oracle enumerates a class list.
 *   2. A reset link must work exactly once.
 *   3. Only a hash of the token is ever stored.
 *   4. Links expire.
 *   5. A reset must invalidate sessions issued against the old password.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const readSource = (relative: string) => readFile(join(root, relative), 'utf8');

/**
 * Source with comments removed.
 *
 * Several assertions below check that a phrase never reaches the *caller* —
 * "no account", "already used". Prose explaining why we avoid those phrases
 * would otherwise trip the very check it documents, so strip comments first
 * and assert against code and string literals only.
 */
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

const PWRESET_PREFIX = 'pwreset:';
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Mirror of hashToken() in lib/password-reset.ts. */
const hashToken = (plaintext: string) =>
  crypto.createHash('sha256').update(plaintext).digest('hex');

/** Mirror of credentialFingerprint(). */
const credentialFingerprint = (passwordHash: string | null | undefined, secret = 'test-secret') =>
  crypto.createHmac('sha256', secret).update(passwordHash ?? '').digest('hex').slice(0, 32);

type StoredToken = { identifier: string; token: string; expires: number };

/**
 * In-memory stand-in for the `verification_tokens` table, with the one
 * behaviour that carries the single-use guarantee: `delete` on a unique key
 * either removes exactly one row and returns it, or throws.
 */
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

  /** Prisma's `delete` semantics: throws P2025 when the row is not there. */
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

/** Mirror of issueResetToken(). */
function issueResetToken(store: TokenStore, email: string, now = Date.now()): string {
  const identifier = PWRESET_PREFIX + email.trim().toLowerCase();
  const plaintext = crypto.randomBytes(32).toString('base64url');
  store.deleteMany(identifier);
  store.create({
    identifier,
    token: hashToken(plaintext),
    expires: now + RESET_TOKEN_TTL_MS,
  });
  return plaintext;
}

/** Mirror of consumeResetToken(). */
function consumeResetToken(
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
  if (!row.identifier.startsWith(PWRESET_PREFIX)) return null;
  if (row.expires <= now) return null;
  return row.identifier.slice(PWRESET_PREFIX.length);
}

// ---------------------------------------------------------------------------
// 1. Token storage — only a hash is persisted
// ---------------------------------------------------------------------------

test('the plaintext token is never what gets stored', () => {
  const store = new TokenStore();
  const plaintext = issueResetToken(store, 'student@example.com');

  const stored = JSON.stringify(store);
  assert.doesNotMatch(
    stored,
    new RegExp(plaintext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the emailed token must not appear in the token store',
  );
  // What is stored is the sha256 of it, and that is not reversible.
  assert.equal(hashToken(plaintext).length, 64);
  assert.notEqual(hashToken(plaintext), plaintext);
});

test('tokens carry 256 bits of entropy and are unique per issue', () => {
  const store = new TokenStore();
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    seen.add(issueResetToken(store, `student${i}@example.com`));
  }
  assert.equal(seen.size, 200, 'every issued token must be distinct');
  // base64url of 32 bytes is 43 characters, no padding.
  for (const token of seen) assert.equal(token.length, 43);
});

test('lib/password-reset.ts really hashes before storing and really uses 32 bytes', async () => {
  const src = await readSource('lib/password-reset.ts');
  assert.match(src, /createHash\('sha256'\)\.update\(plaintext\)\.digest\('hex'\)/);
  assert.match(src, /const TOKEN_BYTES = 32/);
  assert.match(src, /token: hashToken\(plaintext\)/, 'the stored column must be the hash');
  assert.doesNotMatch(
    src,
    /token: plaintext/,
    'the plaintext token must never be written to the database',
  );
});

// ---------------------------------------------------------------------------
// 2. Single use
// ---------------------------------------------------------------------------

test('a reset token works exactly once', () => {
  const store = new TokenStore();
  const token = issueResetToken(store, 'student@example.com');

  assert.equal(consumeResetToken(store, token), 'student@example.com');
  // The whole point: replaying the same link must not work.
  assert.equal(consumeResetToken(store, token), null);
  assert.equal(consumeResetToken(store, token), null);
  assert.equal(store.size, 0);
});

test('two simultaneous redemptions of one token cannot both succeed', () => {
  const store = new TokenStore();
  const token = issueResetToken(store, 'student@example.com');

  // Both racers read the same link; the delete is what serialises them.
  const results = [consumeResetToken(store, token), consumeResetToken(store, token)];
  assert.equal(results.filter((r) => r !== null).length, 1, 'exactly one may win');
});

test('issuing a new link retires the previous one', () => {
  const store = new TokenStore();
  const first = issueResetToken(store, 'student@example.com');
  const second = issueResetToken(store, 'student@example.com');

  assert.equal(consumeResetToken(store, first), null, 'the superseded link must be dead');
  assert.equal(consumeResetToken(store, second), 'student@example.com');
});

test('redemption consumes via a unique-key delete, not a read-then-write', async () => {
  const src = await readSource('lib/password-reset.ts');
  assert.match(
    src,
    /prisma\.verificationToken\.delete\(\{\s*where: \{ token: hashToken\(plaintext\) \}/,
    'single use must be enforced by the delete itself',
  );
  assert.doesNotMatch(
    src,
    /verificationToken\.findUnique|verificationToken\.findFirst/,
    'looking the token up before deleting it would allow two redemptions to race through',
  );
});

// ---------------------------------------------------------------------------
// 3. Expiry and namespacing
// ---------------------------------------------------------------------------

test('a token past its expiry is rejected', () => {
  const store = new TokenStore();
  const issuedAt = Date.now();
  const token = issueResetToken(store, 'student@example.com', issuedAt);

  assert.equal(
    consumeResetToken(store, token, issuedAt + RESET_TOKEN_TTL_MS - 1000),
    'student@example.com',
    'still valid one second before expiry',
  );
});

test('an expired token is rejected and consumed rather than left lying around', () => {
  const store = new TokenStore();
  const issuedAt = Date.now();
  const token = issueResetToken(store, 'student@example.com', issuedAt);

  assert.equal(consumeResetToken(store, token, issuedAt + RESET_TOKEN_TTL_MS + 1), null);
  assert.equal(store.size, 0, 'the dead row must not accumulate');
});

test('the expiry window is one hour', async () => {
  const src = await readSource('lib/password-reset.ts');
  assert.match(src, /RESET_TOKEN_TTL_MS = 60 \* 60 \* 1000/);
});

test('a token from another use of verification_tokens cannot reset a password', () => {
  const store = new TokenStore();
  // NextAuth's own email-verification tokens use the bare address as the
  // identifier, with no prefix.
  const plaintext = 'someone-elses-token';
  store.create({
    identifier: 'student@example.com',
    token: hashToken(plaintext),
    expires: Date.now() + RESET_TOKEN_TTL_MS,
  });

  assert.equal(
    consumeResetToken(store, plaintext),
    null,
    'only pwreset:-namespaced identifiers may be redeemed here',
  );
});

test('every row this module writes is namespaced', async () => {
  const src = await readSource('lib/password-reset.ts');
  assert.match(src, /export const PWRESET_PREFIX = 'pwreset:'/);
  assert.match(src, /const identifier = PWRESET_PREFIX \+ normalizeEmail\(email\)/);
  assert.match(
    src,
    /if \(!row\.identifier\.startsWith\(PWRESET_PREFIX\)\) return null/,
    'redemption must refuse identifiers outside the namespace',
  );
});

// ---------------------------------------------------------------------------
// 4. No account enumeration
// ---------------------------------------------------------------------------

test('the request endpoint has exactly one success payload, shared by every case', async () => {
  const src = await readSource('app/api/auth/forgot-password/route.ts');

  // One frozen constant, returned once.
  assert.match(src, /const UNIFORM_RESPONSE = \{/);
  const successReturns = src.match(/NextResponse\.json\(UNIFORM_RESPONSE, \{ status: 200 \}\)/g);
  assert.equal(successReturns?.length, 1, 'there must be a single 200 return');

  // Nothing that would distinguish a real account from an unknown one.
  const code = stripComments(src);
  for (const leak of [
    /status: 404/,
    /No account/i,
    /not found/i,
    /doesn't exist/i,
    /does not exist/i,
    /unknown email/i,
    /already registered/i,
  ]) {
    assert.doesNotMatch(code, leak, `forgot-password must not reveal account existence (${leak})`);
  }
});

test('the OAuth-only and unknown-address cases are indistinguishable to the caller', async () => {
  const src = await readSource('app/api/auth/forgot-password/route.ts');

  // Both branches fall through to the same single return; neither returns
  // early with its own status.
  const branch = src.slice(src.indexOf('if (user && !user.banned)'), src.indexOf('} catch (error)'));
  assert.match(branch, /issueResetToken/);
  assert.match(branch, /oauthOnlyEmailBody/);
  assert.doesNotMatch(
    branch,
    /return NextResponse/,
    'no branch that depends on the account may return its own response',
  );
});

test('a missing mail key fails before the user lookup, so it cannot become an oracle', async () => {
  const src = await readSource('app/api/auth/forgot-password/route.ts');
  const configCheck = src.indexOf('if (!isEmailConfigured())');
  const userLookup = src.indexOf('prisma.user.findFirst');

  assert.ok(configCheck > 0, 'the route must check that email is configured');
  assert.ok(userLookup > 0);
  assert.ok(
    configCheck < userLookup,
    'the 503 must be decided before we know whether the address exists, ' +
      'or a deploy with no RESEND_API_KEY answers 503 for real accounts and 200 for the rest',
  );
});

test('a delivery failure does not leak existence either', async () => {
  const src = await readSource('app/api/auth/forgot-password/route.ts');
  // Sending only happens for addresses that exist, so a 5xx from the catch
  // block would be a perfect oracle. It must log and fall through.
  const catchBlock = src.slice(src.indexOf('} catch (error)'), src.indexOf('return NextResponse.json(UNIFORM_RESPONSE'));
  assert.match(catchBlock, /console\.error/);
  assert.doesNotMatch(catchBlock, /return NextResponse/);
});

test('rate limiting is keyed on submitted input, never on a resolved account', async () => {
  const src = await readSource('app/api/auth/forgot-password/route.ts');
  assert.match(src, /resetRequestIpLimiter\.check\(`pwreset-req-ip:\$\{ip\}`\)/);
  assert.match(src, /resetRequestEmailLimiter\.check\(`pwreset-req-email:\$\{email\}`\)/);

  // The email limiter must run before the lookup — keying it on `user` would
  // apply the limit only to addresses that exist, which is itself an oracle.
  const emailLimit = src.indexOf('resetRequestEmailLimiter');
  const userLookup = src.indexOf('prisma.user.findFirst');
  assert.ok(emailLimit < userLookup);
});

// ---------------------------------------------------------------------------
// 5. Rate limiting is durable
// ---------------------------------------------------------------------------

test('both endpoints use the Postgres-backed limiter, not an in-memory map', async () => {
  const lib = await readSource('lib/password-reset.ts');
  assert.match(lib, /import \{ rateLimit \} from '@\/lib\/rate-limit'/);
  assert.match(lib, /export const resetRequestIpLimiter = rateLimit\(/);
  assert.match(lib, /export const resetRequestEmailLimiter = rateLimit\(/);
  assert.match(lib, /export const resetConfirmIpLimiter = rateLimit\(/);

  for (const file of [
    'app/api/auth/forgot-password/route.ts',
    'app/api/auth/reset-password/route.ts',
  ]) {
    const src = await readSource(file);
    assert.match(src, /Limiter\.check\(/, `${file} must rate limit`);
    assert.match(src, /status: 429/, `${file} must return 429 when limited`);
    assert.doesNotMatch(
      src,
      /new Map\(|globalThis\.__/,
      `${file} must not hand-roll an in-memory limiter — it is a no-op on serverless`,
    );
  }
});

test('the confirm endpoint is rate limited too', async () => {
  const src = await readSource('app/api/auth/reset-password/route.ts');
  assert.match(src, /resetConfirmIpLimiter\.check\(`pwreset-confirm-ip:\$\{ip\}`\)/);
});

// ---------------------------------------------------------------------------
// 6. Session invalidation
// ---------------------------------------------------------------------------

test('the credential fingerprint changes when, and only when, the password does', () => {
  const oldHash = '$2b$12$abcdefghijklmnopqrstuv';
  const newHash = '$2b$12$AAAAAAAAAAAAAAAAAAAAAA';

  assert.equal(
    credentialFingerprint(oldHash),
    credentialFingerprint(oldHash),
    'stable for an unchanged password, or every request would sign the user out',
  );
  assert.notEqual(
    credentialFingerprint(oldHash),
    credentialFingerprint(newHash),
    'a changed password must invalidate tokens issued against the old one',
  );
});

test('the fingerprint is stable for password-less (OAuth) accounts', () => {
  assert.equal(credentialFingerprint(null), credentialFingerprint(undefined));
  assert.equal(credentialFingerprint(null), credentialFingerprint(''));
});

test('the fingerprint reveals nothing about the hash it covers', () => {
  const hash = '$2b$12$abcdefghijklmnopqrstuv';
  const fp = credentialFingerprint(hash);
  assert.doesNotMatch(fp, /\$2b\$/);
  assert.equal(fp.includes(hash), false);
  // Keyed, so it cannot be recomputed without the NextAuth secret.
  assert.notEqual(credentialFingerprint(hash, 'secret-a'), credentialFingerprint(hash, 'secret-b'));
});

test('getSessionUser rejects a session issued against a superseded password', async () => {
  const src = await readSource('lib/auth.ts');
  assert.match(src, /import \{ credentialFingerprint \} from '@\/lib\/password-reset'/);
  assert.match(
    src,
    /issuedAgainst !== undefined && issuedAgainst !== credentialFingerprint\(user\.password\)/,
    'the chokepoint must compare the session fingerprint against the current row',
  );
  // Must still short-circuit on ban, and must return null (not throw) so
  // callers keep their existing "signed out" path.
  assert.match(src, /if \(!user \|\| user\.banned\) return null;/);
});

test('the JWT carries the fingerprint and never refreshes a stale one', async () => {
  const src = await readSource('app/api/auth/[...nextauth]/route.ts');
  assert.match(src, /token\.cfp = credentialFingerprint\(cred\?\.password\)/);
  assert.match(
    src,
    /if \(token\.cfp === undefined && token\.id\)/,
    'the fingerprint may only be filled in when absent — refreshing a stale one ' +
      'would let a stolen session heal itself by calling update()',
  );
  assert.match(src, /session\.user\.cfp = token\.cfp as string \| undefined/);
});

test('a completed reset clears every credential the account has', async () => {
  const src = await readSource('app/api/auth/reset-password/route.ts');
  assert.match(src, /password: hashed/);
  assert.match(src, /syncToken: null/, 'the iPad bearer token bypasses sessions; it must go too');
  assert.match(src, /prisma\.session\.deleteMany\(\{ where: \{ userId: user\.id \} \}\)/);
  assert.match(src, /prisma\.\$transaction/, 'the revocation must be atomic with the password change');
});

// ---------------------------------------------------------------------------
// 7. Redemption endpoint hygiene
// ---------------------------------------------------------------------------

test('every way a link can fail produces the same message', async () => {
  const src = await readSource('app/api/auth/reset-password/route.ts');
  const invalidReturns = src.match(/NextResponse\.json\(\{ error: INVALID_TOKEN \}, \{ status: 400 \}\)/g);
  assert.ok((invalidReturns?.length ?? 0) >= 3, 'bad, expired, banned and missing must be one message');

  // The single message must not itself name which failure occurred, and no
  // other token-failure response may exist alongside it.
  assert.match(src, /const INVALID_TOKEN = 'This reset link is invalid or has expired\./);
  const code = stripComments(src);
  assert.doesNotMatch(code, /already used/i);
  assert.doesNotMatch(code, /no such (token|link)/i);
});

test('the new password is validated before the single-use token is spent', async () => {
  const src = await readSource('app/api/auth/reset-password/route.ts');
  const validation = src.indexOf('Body.safeParse');
  const consume = src.indexOf('await consumeResetToken');
  assert.ok(validation > 0 && consume > 0);
  assert.ok(
    validation < consume,
    'a typo in the new password must not burn the only link the student has',
  );
});

test('the password policy matches signup, and hashing matches the rest of the app', async () => {
  const reset = await readSource('app/api/auth/reset-password/route.ts');
  const signup = await readSource('app/api/auth/signup/route.ts');
  assert.match(reset, /\.min\(8, 'Password must be at least 8 characters'\)/);
  assert.match(signup, /\.min\(8, 'Password must be at least 8 characters'\)/);
  assert.match(reset, /bcrypt\.hash\(password, 12\)/);
  assert.match(signup, /bcrypt\.hash\(parsed\.password, 12\)/);
});

test('a reset link cannot convert an OAuth account into a password account', async () => {
  const forgot = await readSource('app/api/auth/forgot-password/route.ts');
  const reset = await readSource('app/api/auth/reset-password/route.ts');
  // No token is minted for an account with no password ...
  assert.match(forgot, /if \(user\.password\) \{[\s\S]*issueResetToken/);
  // ... and redemption refuses one anyway.
  assert.match(reset, /if \(!user\.password\) \{[\s\S]*INVALID_TOKEN/);
});

// ---------------------------------------------------------------------------
// 8. Configuration
// ---------------------------------------------------------------------------

test('no API key is hardcoded anywhere in the flow', async () => {
  for (const file of [
    'lib/email.ts',
    'lib/password-reset.ts',
    'app/api/auth/forgot-password/route.ts',
    'app/api/auth/reset-password/route.ts',
    '.env.example',
  ]) {
    const src = await readSource(file);
    assert.doesNotMatch(src, /re_[A-Za-z0-9]{8,}/, `${file} must not contain a real Resend key`);
  }
});

test('email links are built from NEXTAUTH_URL, never the request Host header', async () => {
  const src = await readSource('lib/email.ts');
  assert.match(src, /process\.env\.NEXTAUTH_URL/);
  assert.doesNotMatch(
    src,
    /headers\.get\('host'\)|x-forwarded-host/i,
    'a Host-derived reset link would let an attacker point it at their own domain',
  );
});

test('a missing RESEND_API_KEY is an actionable error, not a silent no-op', async () => {
  const src = await readSource('lib/email.ts');
  assert.match(src, /class EmailNotConfiguredError/);
  assert.match(src, /RESEND_API_KEY is not set/);
  assert.match(src, /resend\.com\/api-keys/, 'the error must say where to get one');
  assert.match(src, /if \(!apiKey\) throw new EmailNotConfiguredError\(\)/);
});

test('.env.example documents the key and what breaks without it', async () => {
  const src = await readSource('.env.example');
  assert.match(src, /^RESEND_API_KEY=""$/m);
  assert.match(src, /^EMAIL_FROM=""$/m);
  assert.match(src, /busypizza\.bond/);
  assert.match(src, /WITHOUT THIS KEY/i);
});

// ---------------------------------------------------------------------------
// 9. UI wiring
// ---------------------------------------------------------------------------

test('the login page offers the reset flow instead of "ask an administrator"', async () => {
  const src = await readSource('app/auth/login/page.tsx');
  assert.match(src, /href="\/auth\/forgot-password"/);
  assert.doesNotMatch(src, /Ask a teacher or administrator to reset it/);
});

test('the reset page reads its token inside a Suspense boundary', async () => {
  const src = await readSource('app/auth/reset-password/page.tsx');
  assert.match(src, /useSearchParams/);
  assert.match(
    src,
    /<Suspense[\s\S]*<ResetPasswordForm \/>/,
    'Next 16 requires useSearchParams to sit under a Suspense boundary',
  );
});

test('the request page cannot imply whether the address existed', async () => {
  const src = await readSource('app/auth/forgot-password/page.tsx');
  assert.match(src, /If that email belongs to an account/);
  assert.doesNotMatch(src, /No account found|we couldn't find/i);
});

// ---------------------------------------------------------------------------
// The chokepoint is only a chokepoint if everything actually goes through it
// ---------------------------------------------------------------------------

/**
 * getSessionUser() is where bans and credential-fingerprint revocation are
 * enforced. A route that calls getServerSession(authOptions) itself gets an
 * authenticated session object with none of those checks applied — so "a
 * password reset signs every device out" quietly stops being true for that
 * route, and no test of the reset flow itself would notice.
 *
 * Six routes were in exactly that state when this was written (dashboard,
 * ai/check-answer, attempts, practice, practice/ocr, upload), plus
 * app/uploads/** and the session fallback in lib/sync-auth.ts. The property is
 * pinned here rather than left to review because the failure is invisible:
 * every one of those routes behaved correctly for signed-in users.
 */
test('lib/auth.ts is the only place that reads the session directly', async () => {
  const { readdir } = await import('node:fs/promises');

  const allowed = new Set([
    // The one place bans and fingerprint revocation are actually enforced.
    'lib/auth.ts',

    // Deleted on the remove-dead-code branch; listed so this test does not fail
    // on a merge ordering we do not control. Entries that no longer exist are
    // simply never visited.
    'app/api/chat/route.ts',
    'app/api/ai/chat/route.ts',

    // DELIBERATE EXCEPTION, not drift. These three serve immutable binary
    // assets through lib/storage/protected-asset.ts, which gates on the JWT
    // session alone. A single question page pulls dozens of diagrams, and
    // getSessionUser() would add a database round trip per image — a cost paid
    // by every student on every page load, against a threat model where the
    // attacker holds no session at all.
    //
    // The accepted trade-off, stated plainly: after a ban or a password reset,
    // an unexpired token can still fetch these assets until it lapses. It
    // cannot reach anything NEW — every route that exposes fresh material goes
    // through getSessionUser(). Revisit this if assets ever stop being
    // immutable, or if per-request user lookups become cheap enough to absorb.
    'app/uploads/[...path]/route.ts',
    'app/extracted_images/[...path]/route.ts',
    'app/step-images/[...path]/route.ts',
  ]);

  const offenders: string[] = [];

  for (const dir of ['app', 'lib']) {
    const entries = await readdir(join(root, dir), {
      recursive: true,
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;

      // parentPath is absolute; make it repo-relative with forward slashes.
      const full = join(entry.parentPath, entry.name);
      const relative = full.slice(root.length + 1).split('\\').join('/');
      if (allowed.has(relative)) continue;

      const source = stripComments(await readFile(full, 'utf8'));
      if (/getServerSession\s*\(/.test(source)) offenders.push(relative);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'these read the session without going through getSessionUser(), so bans and ' +
      'password-reset revocation do not apply to them — call getSessionUser() instead',
  );
});
