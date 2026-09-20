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
