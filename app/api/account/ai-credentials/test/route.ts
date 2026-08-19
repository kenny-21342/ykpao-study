import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { keyTestLimiter } from '@/lib/rate-limit';
import { probeTextCredential, resolveOwnTextCredential } from '@/lib/ai-key-test';

export const dynamic = 'force-dynamic';
// The probe itself gives up after 15s; this leaves room to answer afterwards.
export const maxDuration = 30;

/**
 * POST /api/account/ai-credentials/test — does the user's own key actually work?
 *
 * Students used to find out their key was wrong halfway through a tutoring
 * session. This makes one minimal completion (`max_tokens: 1`) against their
 * configured endpoint and reports pass/fail.
 *
 * Three properties this route exists to hold:
 *
 *  1. **The user's own key only.** It reads the credential row directly and
 *     hands the three own-key columns to `resolveOwnTextCredential`, which
 *     cannot see `sharedKeyAccess` (it is not in that function's parameter
 *     type) and never touches `process.env`. `resolveAiCredentials` — the
 *     resolver that *does* fall back to the owner's shared key — is
 *     deliberately not imported here. A student with a broken key must see a
 *     failure even when an admin has granted them shared access.
 *  2. **The key never comes back out.** Only a boolean and a sanitised
 *     provider message are returned, and the message has the key redacted out
 *     of it before it is either logged or sent.
 *  3. **It is not spammable.** Every press is an outbound request to a
 *     user-supplied URL, so it sits behind its own tight limiter.
 */
export async function POST() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!(await keyTestLimiter.check(`ai-key-test:${user.id}`))) {
    return NextResponse.json(
      { error: 'You have tested your key several times in the last minute. Please wait a moment and try again.' },
      { status: 429 },
    );
  }

  const row = await prisma.userAiCredential.findUnique({
    where: { userId: user.id },
    // Exactly the three own-key columns. `sharedKeyAccess` is not selected, so
    // there is nothing here that could route the test at the platform key.
    select: { encryptedApiKey: true, baseUrl: true, textModel: true },
  });

  const resolved = resolveOwnTextCredential(row);
  if (!resolved.ok) {
    // 400, not 503: this is a state the student fixes in the form above, not a
    // server fault, and it is emphatically not a passing test.
    return NextResponse.json(
      { ok: false, reason: resolved.reason, message: resolved.error },
      { status: 400 },
    );
  }

  const result = await probeTextCredential(resolved.credential);

  if (!result.ok) {
    console.warn(
      '[ai-key-test] user %s: key test failed (status=%s)',
      user.id,
      result.status ?? 'none',
    );
  }

  // Only ever a boolean, a status and an already-sanitised message.
  return NextResponse.json({
    ok: result.ok,
    status: result.status,
    message: result.message,
    model: resolved.credential.model,
    // Stated so the panel can tell the student plainly that a pass here says
    // nothing about handwriting OCR — testing vision would need a real image.
    visionTested: false,
  });
}
