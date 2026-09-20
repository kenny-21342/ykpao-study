import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

import { databaseSsl } from '../lib/db-ssl.ts';

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
 * That is a defensible thing to do for ten minutes during a migration. These
 * tests exist so it cannot happen by accident, cannot happen silently, and
 * cannot be the default.
 */

const saved = { ...process.env };
afterEach(() => {
  for (const key of ['DATABASE_SSL_CA', 'DATABASE_SSL_NO_VERIFY']) {
    delete process.env[key];
    if (saved[key] !== undefined) process.env[key] = saved[key];
  }
});

const URL_PLAIN = 'postgres://u:p@db.example.com:5432/defaultdb?sslmode=require';

test('with no configuration, TLS is left to the connection string', () => {
  // Never a silent downgrade: a provider with a publicly-trusted certificate
  // must keep verifying, and one without must fail loudly rather than
  // connect unverified.
  assert.equal(databaseSsl(URL_PLAIN), undefined);
});

test('a CA certificate turns verification on, not off', () => {
  process.env.DATABASE_SSL_CA = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
  const ssl = databaseSsl(URL_PLAIN);
  assert.equal(typeof ssl, 'object');
  assert.equal((ssl as { rejectUnauthorized: boolean }).rejectUnauthorized, true);
  assert.match((ssl as { ca: string }).ca, /BEGIN CERTIFICATE/);
});

test('escaped newlines in the CA are restored', () => {
  // Environment panels routinely flatten a multi-line value to one line with
  // literal \n, and a PEM that keeps those is not a PEM.
  process.env.DATABASE_SSL_CA =
    '-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----';
  const ssl = databaseSsl(URL_PLAIN) as { ca: string };
  assert.ok(!ssl.ca.includes('\\n'), 'literal backslash-n survived into the PEM');
  assert.equal(ssl.ca.split('\n').length, 3);
});

test('base64 of the certificate file is accepted', () => {
  // The shape to reach for when the other two have gone wrong: no newlines
  // to lose, nothing to escape.
  const pem = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
  process.env.DATABASE_SSL_CA = Buffer.from(pem, 'utf8').toString('base64');
  const ssl = databaseSsl(URL_PLAIN) as { ca: string; rejectUnauthorized: boolean };
  assert.equal(ssl.ca, pem);
  assert.equal(ssl.rejectUnauthorized, true);
});

test('a truncated paste fails loudly rather than as a TLS error later', () => {
  // `vercel env add` reads one line from the terminal, so pasting a PEM at
  // the prompt keeps only "-----BEGIN CERTIFICATE-----". The variable looks
  // set and the certificate is unusable; without this the first symptom is a
  // TLS handshake failure that says nothing about the value.
  process.env.DATABASE_SSL_CA = '-----BEGIN CERTIFICATE-----';
  assert.throws(() => databaseSsl(URL_PLAIN), /base64/);
});

test('verification is only skipped when explicitly asked for', () => {
  for (const [label, setup] of [
    ['sslmode=no-verify in the URL', () => undefined],
    ['DATABASE_SSL_NO_VERIFY=1', () => { process.env.DATABASE_SSL_NO_VERIFY = '1'; }],
  ] as const) {
    setup();
    const url = label.startsWith('sslmode')
      ? 'postgres://u:p@db.example.com:5432/defaultdb?sslmode=no-verify'
      : URL_PLAIN;
    const ssl = databaseSsl(url) as { rejectUnauthorized: boolean };
    assert.equal(ssl.rejectUnauthorized, false, label);
    delete process.env.DATABASE_SSL_NO_VERIFY;
  }
});

test('a CA beats no-verify', () => {
  // If both are set, the secure one wins -- otherwise a no-verify left over
  // from a migration silently outranks the certificate added to end it.
  process.env.DATABASE_SSL_CA = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----';
  process.env.DATABASE_SSL_NO_VERIFY = '1';
  const ssl = databaseSsl(URL_PLAIN) as { rejectUnauthorized: boolean };
  assert.equal(ssl.rejectUnauthorized, true);
});
