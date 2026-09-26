import type { ConnectionOptions } from 'node:tls';

/**
 * TLS settings for a managed Postgres whose certificate chain Node does not
 * trust out of the box.
 *
 * Neon's certificates chain to a public CA, so `pg` connected to it with no
 * TLS configuration at all. Aiven issues its own per-project CA, and the
 * first request after moving there failed with:
 *
 *     Error opening a TLS connection: self-signed certificate in certificate
 *     chain
 *
 * There are two honest ways to fix that and one dishonest one.
 *
 * The right fix is to tell Node about Aiven's CA, which is what
 * `DATABASE_SSL_CA` is for: paste the project CA certificate (it is a public
 * certificate, not a secret) and the chain verifies properly, with the
 * hostname checked and a man in the middle still shut out.
 *
 * The fallback is `sslmode=no-verify` in the URL, or
 * `DATABASE_SSL_NO_VERIFY=1`. That keeps the traffic encrypted but stops
 * checking who is on the other end, so anyone able to intercept the
 * connection can read and rewrite every query. It is a reasonable thing to
 * reach for in the ten minutes after a migration and a bad thing to still be
 * running a month later, which is why it must be asked for explicitly and
 * says so in the log.
 *
 * The dishonest option -- `rejectUnauthorized: false` hard-coded, with no
 * way to tell from the outside -- is the one this module exists to prevent.
 */
/**
 * A PEM certificate, however the environment mangled it on the way in.
 *
 * A CA certificate is multi-line and environment variables frequently are
 * not. `vercel env add` reads a single line from the terminal, so pasting a
 * PEM at the prompt silently keeps only its first line; other panels flatten
 * the value to one line with literal backslash-n. Both produce a variable
 * that looks set and a certificate that cannot be parsed, and the error
 * surfaces later as a TLS failure rather than as a bad value here.
 *
 * So all three shapes are accepted: a real PEM, a flattened one with escaped
 * newlines, and base64 of the whole file -- which has no newlines to lose
 * and nothing to escape, and is the one to reach for when the other two have
 * already gone wrong.
 */
function decodeCa(raw: string): string {
  // Both markers, not just the opening one: a value truncated to its first
  // line still contains "BEGIN CERTIFICATE" and is useless, which is exactly
  // the failure this function exists to name.
  const complete = (value: string) =>
    value.includes('BEGIN CERTIFICATE') && value.includes('END CERTIFICATE');

  const unescaped = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  if (complete(unescaped)) return unescaped;

  const decoded = Buffer.from(raw, 'base64').toString('utf8');
  if (complete(decoded)) return decoded;

  throw new Error(
    'DATABASE_SSL_CA is set but is neither a PEM certificate nor base64 of ' +
      'one. If it was pasted at a prompt, the value was probably truncated ' +
      'to its first line: pipe the file in instead (vercel env add NAME ' +
      'production < ca.pem) or set it to `base64 -i ca.pem`.',
  );
}

function databaseSsl(url: string): ConnectionOptions | boolean | undefined {
  const ca = process.env.DATABASE_SSL_CA?.trim();
  if (ca) {
    return { ca: decodeCa(ca), rejectUnauthorized: true };
  }

  const noVerify =
    process.env.DATABASE_SSL_NO_VERIFY === '1' ||
    /[?&]sslmode=no-verify\b/.test(url);

  if (noVerify) {
    console.warn(
      '[db] TLS certificate verification is OFF. The connection is encrypted ' +
        'but unauthenticated, so anyone who can intercept it can read and ' +
        'alter queries. Set DATABASE_SSL_CA to the provider CA certificate ' +
        'to turn verification back on.',
    );
    return { rejectUnauthorized: false };
  }

  // Nothing configured: let `pg` derive TLS from the connection string, which
  // is what a provider with a publicly-trusted certificate needs.
  return undefined;
}

/**
 * A `pg` pool config that actually applies the TLS settings above.
 *
 * `pg` builds its parameters as `Object.assign({}, config, parse(
 * connectionString))` -- the parsed URL wins. So an `sslmode` in the URL
 * does not merge with an explicit `ssl` option, it **replaces** it:
 *
 *     new Client({ connectionString: '...?sslmode=require',
 *                  ssl: { ca, rejectUnauthorized: true } })
 *     // .connectionParameters.ssl === {}
 *
 * The CA is silently dropped and verification falls back to the system trust
 * store, which is the exact failure it was added to fix. This cost a deploy
 * to find, because everything about the configuration looks right: the
 * variable is set, the certificate is valid, and the error is unchanged.
 *
 * So when we supply TLS options, `sslmode` comes out of the URL. Postgres
 * still gets TLS -- it comes from the `ssl` option instead, which is now the
 * only thing describing it.
 */
export function pgConfig(url: string): { connectionString: string; ssl?: ConnectionOptions | boolean } {
  const ssl = databaseSsl(url);
  if (ssl === undefined) return { connectionString: url };

  const stripped = url.replace(/([?&])sslmode=[^&]*(&|$)/, (_m, lead: string, tail: string) =>
    tail === '&' ? lead : (lead === '?' ? '' : ''),
  );
  return { connectionString: stripped, ssl };
}

/**
 * Ask the *server* to hang up on sessions we have stopped using.
 *
 * `pg` reaps its own idle clients on a timer. A frozen serverless instance
 * cannot run timers, so between requests that reaping simply does not
 * happen: the instance keeps every socket it ever opened until the platform
 * recycles it, which can be many minutes later and is not something the
 * application gets a say in.
 *
 * On 21 Sep 2026 that emptied a 20-connection plan. Every slot was held,
 * nothing was running a query, and the app could not open a connection to
 * find out why -- including the health check, which is how a database with
 * no load at all took production down.
 *
 * `idle_session_timeout` moves the reaping to the one party that is always
 * awake. Postgres terminates a session that has sat idle outside a
 * transaction for this long, so a slot held by a frozen instance comes back
 * on its own. It does not touch a session that is mid-query or
 * mid-transaction, so no in-flight work is at risk; the cost is that the
 * pool occasionally finds a dead client and opens a fresh one, which is a
 * reconnect, not an error.
 *
 * Do NOT apply this to the LISTEN/NOTIFY pool in `lib/page-pubsub.ts`. A
 * subscription is *supposed* to sit idle -- that is what waiting for a
 * notification looks like -- and terminating it would silently stop
 * collaboration updates, the exact failure that file already warns about.
 *
 * **Thirty seconds, lowered from 120 on 27 Sep 2026.** Two minutes was still
 * far too generous for the size of the budget. Measured while one signed-in
 * person browsed the dashboard and nothing else was running: nine of the
 * seventeen usable slots were held, every one of them idle, the oldest for 75
 * seconds -- three warm instances times a pool of three. The visible symptom
 * was `/api/daily-challenge` and `/api/onboarding` answering 503 and the
 * dashboard reporting that progress could not be loaded, on a platform with a
 * single user on it.
 *
 * A connection idle for thirty seconds on a frozen instance is not a warm
 * cache, it is a slot nobody can use. Reclaiming it costs a reconnect the next
 * time that instance wakes; holding it costs somebody else their page. The
 * timeout does not touch a session that is mid-query or inside a transaction,
 * so nothing in flight is at risk either way.
 */
export function idleSessionTimeoutMs(): number {
  const raw = Number.parseInt(process.env.DB_IDLE_SESSION_TIMEOUT_MS ?? '', 10);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 30_000;
}

/**
 * `pgConfig` plus a server-side idle timeout, for pools whose connections are
 * only ever used to run a query and hand back.
 */
export function pgQueryConfig(url: string): ReturnType<typeof pgConfig> & { options?: string } {
  const base = pgConfig(url);
  const timeout = idleSessionTimeoutMs();
  if (timeout === 0) return base;
  // A startup-packet option, so it is set before the first query and applies
  // to a connection the pool never gets to touch again.
  return { ...base, options: `-c idle_session_timeout=${timeout}` };
}
