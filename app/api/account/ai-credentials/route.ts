import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { aiLimiter } from '@/lib/rate-limit';
import { encryptSecret, isCredentialEncryptionConfigured, maskSecret } from '@/lib/credential-crypto';
import {
  resolveAiCredentials,
  validateBaseUrl,
  visionDisabledMessage,
  type AiCredentialStatus,
} from '@/lib/ai-credentials';

export const dynamic = 'force-dynamic';

/**
 * The signed-in user's own AI provider settings.
 *
 * The one invariant this file exists to hold: **the API key is write-only**.
 * It goes in encrypted, it comes back only as a four-character hint, and there
 * is no endpoint, parameter or error path that returns the plaintext. A
 * student who forgets their key re-pastes it; they never read it back out of
 * us, and neither does anyone who steals a session.
 */

const SaveBody = z.object({
  // Optional on update: omitting it keeps the stored key and edits only the
  // endpoint/models, which is what "change my model name" should do.
  apiKey: z.string().trim().min(8).max(400).optional(),
  baseUrl: z.string().trim().min(1).max(400),
  textModel: z.string().trim().min(1).max(120),
  // Empty string clears the vision model (and disables handwriting OCR).
  visionModel: z.string().trim().max(120).optional(),
});

/** Exactly the shape the settings UI renders. Never includes a secret. */
function publicView(status: AiCredentialStatus) {
  return {
    hasOwnKey: status.hasOwnKey,
    keyHint: status.keyHint,
    baseUrl: status.baseUrl,
    textModel: status.textModel,
    visionModel: status.visionModel,
    sharedKeyAccess: status.sharedKeyAccess,
    source: status.source,
    textEnabled: status.textEnabled,
    visionEnabled: status.visionEnabled,
    encryptionConfigured: status.encryptionConfigured,
    keyUndecryptable: status.keyUndecryptable,
    visionNotice:
      status.textEnabled && !status.visionEnabled
        ? visionDisabledMessage(status.textModel)
        : null,
  };
}

// GET /api/account/ai-credentials — current state of this user's AI access.
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { status } = await resolveAiCredentials(user.id);
  return NextResponse.json({ credentials: publicView(status) });
}

// PUT /api/account/ai-credentials — save or update the user's own credentials.
export async function PUT(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Writing credentials is cheap but is also an obvious brute-force surface
  // for anything that manages to get a session; keep it behind a limiter.
  if (!(await aiLimiter.check(`ai-credentials:${user.id}`))) {
    return NextResponse.json(
      { error: 'Too many changes. Please wait a minute and try again.' },
      { status: 429 },
    );
  }

  if (!isCredentialEncryptionConfigured()) {
    // Refusing is the only safe answer: the alternative is storing a real
    // third-party key in plaintext.
    return NextResponse.json(
      {
        error:
          'This server cannot store API keys yet because CREDENTIAL_ENCRYPTION_KEY is not configured. Please tell an administrator.',
      },
      { status: 503 },
    );
  }

  let body: z.infer<typeof SaveBody>;
  try {
    body = SaveBody.parse(await req.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid request' },
      { status: 400 },
    );
  }

  const baseUrl = validateBaseUrl(body.baseUrl);
  if (!baseUrl) {
    return NextResponse.json(
      {
        error:
          'The API endpoint must be an https:// URL, for example https://api.deepseek.com/v1',
      },
      { status: 400 },
    );
  }

  const existing = await prisma.userAiCredential.findUnique({
    where: { userId: user.id },
    select: { encryptedApiKey: true },
  });

  if (!body.apiKey && !existing?.encryptedApiKey) {
    return NextResponse.json(
      { error: 'An API key is required the first time you save these settings.' },
      { status: 400 },
    );
  }

  const keyFields = body.apiKey
    ? { encryptedApiKey: encryptSecret(body.apiKey), keyHint: maskSecret(body.apiKey) }
    : {};

  const data = {
    ...keyFields,
    baseUrl,
    textModel: body.textModel,
    visionModel: body.visionModel?.trim() ? body.visionModel.trim() : null,
  };

  await prisma.userAiCredential.upsert({
    where: { userId: user.id },
    create: { userId: user.id, ...data },
    update: data,
  });

  const { status } = await resolveAiCredentials(user.id);
  return NextResponse.json({ ok: true, credentials: publicView(status) });
}

/**
 * DELETE /api/account/ai-credentials — forget the user's key.
 *
 * Clears the credential columns but keeps the row when an admin has granted
 * shared access, so removing your own key does not silently revoke a grant
 * only an admin is supposed to be able to change.
 */
export async function DELETE() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const existing = await prisma.userAiCredential.findUnique({
    where: { userId: user.id },
    select: { sharedKeyAccess: true },
  });

  if (existing) {
    if (existing.sharedKeyAccess) {
      await prisma.userAiCredential.update({
        where: { userId: user.id },
        data: {
          encryptedApiKey: null,
          keyHint: null,
          baseUrl: null,
          textModel: null,
          visionModel: null,
        },
      });
    } else {
      await prisma.userAiCredential.delete({ where: { userId: user.id } });
    }
  }

  const { status } = await resolveAiCredentials(user.id);
  return NextResponse.json({ ok: true, credentials: publicView(status) });
}
