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
export function databaseSsl(url: string): ConnectionOptions | boolean | undefined {
  const ca = process.env.DATABASE_SSL_CA?.trim();
  if (ca) {
    // Escaped newlines survive environment panels that flatten multi-line
    // values; a real PEM works unchanged.
    return { ca: ca.replace(/\\n/g, '\n'), rejectUnauthorized: true };
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
