import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

/**
 * Verified against production on 28 Sep 2026: SPF, DKIM and DMARC all PASS
 * and Gmail still delivers the confirmation mail to Junk. Nothing in DNS
 * fixes that -- it is sender reputation on a new `.bond` domain whose name
 * does not match the brand. Until the sending domain changes, telling the
 * student where the mail actually went IS the mitigation, so it is guarded
 * like any other launch-critical behaviour.
 */
test('both signup and verify tell the student to look in spam', () => {
  for (const file of ['app/auth/signup/page.tsx', 'app/auth/verify/page.tsx']) {
    const src = read(file);
    assert.ok(/spam|junk/i.test(src), `${file} must name the spam/junk folder`);
    assert.ok(
      /Not spam|not spam/i.test(src),
      `${file} must tell the student to mark it Not spam -- that is what improves deliverability`,
    );
    assert.ok(
      /no-reply@busypizza\.bond/.test(src),
      `${file} must name the sender so the student can search for it`,
    );
  }
});
