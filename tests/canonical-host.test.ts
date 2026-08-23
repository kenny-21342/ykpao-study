import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalRedirectUrl } from '../lib/canonical-host.ts';

const CANONICAL = 'https://study.busypizza.bond';

test('passes through a request already on the canonical host', () => {
  assert.equal(canonicalRedirectUrl(`${CANONICAL}/papers?year=2023`, CANONICAL), null);
});

test('redirects an alias, preserving path and query', () => {
  assert.equal(
    canonicalRedirectUrl('https://ykpao-study.vercel.app/papers?year=2023', CANONICAL),
    'https://study.busypizza.bond/papers?year=2023',
  );
});

test('redirects the OAuth callback that motivated this', () => {
  assert.equal(
    canonicalRedirectUrl(
      'https://ykpao-study-ykp-ao-study.vercel.app/api/auth/callback/google?code=abc&state=xyz',
      CANONICAL,
    ),
    'https://study.busypizza.bond/api/auth/callback/google?code=abc&state=xyz',
  );
});

test('does nothing without a canonical origin, rather than taking the site down', () => {
  assert.equal(canonicalRedirectUrl('https://anything.example/x', undefined), null);
  assert.equal(canonicalRedirectUrl('https://anything.example/x', ''), null);
});

test('does not loop when only the scheme differs', () => {
  // A TLS-terminating proxy can forward as http; matching on host avoids a
  // redirect that would arrive looking exactly the same.
  assert.equal(canonicalRedirectUrl('http://study.busypizza.bond/papers', CANONICAL), null);
});

test('ignores an unparseable canonical origin', () => {
  assert.equal(canonicalRedirectUrl('https://alias.example/x', 'not a url'), null);
});
