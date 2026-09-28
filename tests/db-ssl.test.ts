import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { Client } from 'pg';

import { pgConfig, pgQueryConfig, idleSessionTimeoutMs } from '../lib/db-ssl.ts';

/**
 * Moving to a provider with its own CA is the moment TLS verification gets
 * quietly switched off and left off.
 *
 * Neon's certificates chain to a public CA, so nothing had to be configured.
 * Aiven issues a per-project CA, and the first request after the move failed
 * with "self-signed certificate in certificate chain". The quickest way past
 * that is `rejectUnauthorized: false`, which keeps the traffic encrypted and
 * stops checking who is on the other end -- every query readable and
 * rewritable by anyone positioned to intercept it.
 *
 * Most of these assertions go through `pg` rather than reading back what our
 * own function returned, because the bug that cost a production deploy was
 * invisible at that level. `pg` builds its parameters as
 * `Object.assign({}, config, parse(connectionString))`, so an `sslmode` in
 * the URL does not merge with an explicit `ssl` option -- it replaces it.
 * Our config was correct, and `pg` threw it away.
 */

const saved = { ...process.env };
afterEach(() => {
  for (const key of ['DATABASE_SSL_CA', 'DATABASE_SSL_NO_VERIFY', 'DB_IDLE_SESSION_TIMEOUT_MS']) {
    delete process.env[key];
    if (saved[key] !== undefined) process.env[key] = saved[key];
  }
});

const PEM = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
const URL_PLAIN = 'postgres://u:p@db.example.com:5432/defaultdb?sslmode=require';

/**
 * What `pg` will actually hand to the TLS socket.
 *
 * `connectionParameters` is real and load-bearing -- it is where the bug
 * showed -- but it is not in pg's published types, hence the cast.
 */
function effectiveSsl(url: string) {
  const client = new Client(pgConfig(url)) as unknown as {
    connectionParameters: {
      ssl?: { ca?: string; rejectUnauthorized?: boolean } | boolean;
    };
  };
  return client.connectionParameters.ssl;
}

test('the CA survives an sslmode in the connection string', () => {
  // The regression. With sslmode left in place pg reported `ssl: {}` here,
  // the certificate never reached the socket, and the TLS error was
  // identical before and after configuring it.
  process.env.DATABASE_SSL_CA = PEM;
  for (const url of [
    URL_PLAIN,
    'postgres://u:p@db.example.com:5432/defaultdb?sslmode=require&application_name=x',
    'postgres://u:p@db.example.com:5432/defaultdb?application_name=x&sslmode=verify-full',
    'postgres://u:p@db.example.com:5432/defaultdb',
  ]) {
    const ssl = effectiveSsl(url) as { ca?: string; rejectUnauthorized?: boolean };
    assert.equal(ssl?.ca, PEM, `CA dropped for: ${url}`);
    assert.equal(ssl?.rejectUnauthorized, true, `verification off for: ${url}`);
  }
});

test('stripping sslmode does not damage the rest of the URL', () => {
  process.env.DATABASE_SSL_CA = PEM;
  const { connectionString } = pgConfig(
    'postgres://u:p@db.example.com:5432/defaultdb?sslmode=require&application_name=x',
  );
  assert.ok(!/sslmode/.test(connectionString));
  assert.match(connectionString, /application_name=x/);
  assert.match(connectionString, /db\.example\.com:5432\/defaultdb/);
});

test('with no configuration, TLS is left to the connection string', () => {
  // Never a silent downgrade: a provider with a publicly-trusted certificate
  // must keep verifying, and one without must fail loudly rather than
  // connect unverified.
  const { connectionString, ssl } = pgConfig(URL_PLAIN);
  assert.equal(ssl, undefined);
  assert.equal(connectionString, URL_PLAIN);
});

test('base64 of the certificate file is accepted', () => {
  // The shape to reach for when a multi-line paste has already gone wrong:
  // no newlines to lose, nothing to escape.
  process.env.DATABASE_SSL_CA = Buffer.from(PEM, 'utf8').toString('base64');
  assert.equal((effectiveSsl(URL_PLAIN) as { ca: string }).ca, PEM);
});

test('escaped newlines in the CA are restored', () => {
  process.env.DATABASE_SSL_CA = PEM.replace(/\n/g, '\\n');
  const ca = (effectiveSsl(URL_PLAIN) as { ca: string }).ca;
  assert.ok(!ca.includes('\\n'), 'literal backslash-n survived into the PEM');
  assert.equal(ca.split('\n').length, 3);
});

test('a truncated paste fails loudly rather than as a TLS error later', () => {
  // `vercel env add` reads one line from the terminal, so pasting a PEM at
  // the prompt keeps only its first line. The variable looks set and the
  // certificate is unusable.
  process.env.DATABASE_SSL_CA = '-----BEGIN CERTIFICATE-----';
  assert.throws(() => pgConfig(URL_PLAIN), /base64/);
});

test('verification is only skipped when explicitly asked for', () => {
  process.env.DATABASE_SSL_NO_VERIFY = '1';
  assert.equal(
    (effectiveSsl(URL_PLAIN) as { rejectUnauthorized: boolean }).rejectUnauthorized,
    false,
  );
  delete process.env.DATABASE_SSL_NO_VERIFY;

  const viaUrl = effectiveSsl(
    'postgres://u:p@db.example.com:5432/defaultdb?sslmode=no-verify',
  ) as { rejectUnauthorized: boolean };
  assert.equal(viaUrl.rejectUnauthorized, false);
});

test('a CA beats no-verify', () => {
  // Otherwise a no-verify left over from a migration silently outranks the
  // certificate added to end it.
  process.env.DATABASE_SSL_CA = PEM;
  process.env.DATABASE_SSL_NO_VERIFY = '1';
  const ssl = effectiveSsl(URL_PLAIN) as { rejectUnauthorized: boolean };
  assert.equal(ssl.rejectUnauthorized, true);
});

/**
 * The connection-slot half of the same story.
 *
 * On 21 Sep 2026 a 20-connection plan ran out of slots with almost no
 * traffic: nine sessions sat idle, the oldest for six and a half minutes,
 * and the app could not open a connection to find out why -- the health
 * check included. A frozen serverless instance cannot run `pg`'s idle
 * reaper, so the only party able to free those slots is the server.
 *
 * These assert through `pg` for the same reason the TLS cases above do: what
 * matters is the parameter `pg` actually sends in the startup packet, not
 * what our function returned.
 */
test('pgQueryConfig asks the server to reap idle sessions', () => {
  const client = new Client(pgQueryConfig('postgres://u:p@h:5432/db'));
  const params = (client as unknown as { connectionParameters: { options?: string } })
    .connectionParameters;
  assert.equal(params.options, '-c idle_session_timeout=30000');
});

test('pgQueryConfig keeps the CA that pgConfig rescued from sslmode', () => {
  process.env.DATABASE_SSL_CA = PEM;
  const client = new Client(pgQueryConfig('postgres://u:p@h:5432/db?sslmode=require'));
  const params = (client as unknown as {
    connectionParameters: { options?: string; ssl?: { ca?: string; rejectUnauthorized?: boolean } };
  }).connectionParameters;
  // Both mechanisms at once: the idle timeout must not reintroduce the
  // sslmode-replaces-ssl bug by handing `pg` an unstripped URL.
  assert.equal(params.options, '-c idle_session_timeout=30000');
  assert.equal(params.ssl?.rejectUnauthorized, true);
  assert.ok(params.ssl?.ca?.includes('BEGIN CERTIFICATE'));
});

test('DB_IDLE_SESSION_TIMEOUT_MS=0 turns the server-side reaper off', () => {
  process.env.DB_IDLE_SESSION_TIMEOUT_MS = '0';
  assert.equal(idleSessionTimeoutMs(), 0);
  const client = new Client(pgQueryConfig('postgres://u:p@h:5432/db'));
  const params = (client as unknown as { connectionParameters: { options?: string } })
    .connectionParameters;
  assert.ok(!params.options);
});

test('a nonsense DB_IDLE_SESSION_TIMEOUT_MS falls back rather than disabling', () => {
  process.env.DB_IDLE_SESSION_TIMEOUT_MS = 'soon';
  // 30s since 27 Sep 2026, when 120s was measured holding nine of seventeen
  // slots idle for a single browsing user. Pinned because the number is a
  // capacity decision, not a preference: raising it re-creates that.
  assert.equal(idleSessionTimeoutMs(), 30_000);
});

/**
 * A pooler rejects startup parameters it does not recognise — it does not
 * ignore them. Sending `options: -c idle_session_timeout=...` to Neon's pooled
 * endpoint on 28 Sep 2026 made every database route answer 500 with
 * `08P01 unsupported startup parameter`. The timeout exists to reclaim a slot
 * from a frozen serverless instance; behind a pooler that is the pooler's job,
 * so dropping it there costs nothing.
 */
test('the idle-session timeout is not sent to a pooled endpoint', () => {
  process.env.DB_IDLE_SESSION_TIMEOUT_MS = '30000';
  delete process.env.DATABASE_SSL_CA;

  const pooled = pgQueryConfig(
    'postgresql://u:p@ep-damp-paper-b868wa1z-pooler.c-14.us-east-1.aws.neon.tech/neondb?sslmode=require',
  );
  assert.equal(
    (pooled as { options?: string }).options,
    undefined,
    'a startup parameter sent through PgBouncer fails every query on the connection',
  );

  // The direct endpoint is what migrations and scripts use, and it still wants
  // the timeout: that connection really is a frozen instance holding a slot.
  const direct = pgQueryConfig(
    'postgresql://u:p@ep-damp-paper-b868wa1z.c-14.us-east-1.aws.neon.tech/neondb?sslmode=require',
  );
  assert.match(
    (direct as { options?: string }).options ?? '',
    /idle_session_timeout=30000/,
    'the direct endpoint lost the timeout that frees slots a frozen instance holds',
  );

  delete process.env.DB_IDLE_SESSION_TIMEOUT_MS;
});
