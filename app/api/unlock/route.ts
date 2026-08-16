import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/**
 * Easter-egg unlock for the competition question vault (STEP / AMC / AIME …).
 *
 * Two supported unlock triggers:
 *
 *   1. Konami code: the classic ↑↑↓↓←→←→BA sequence, sent as
 *      { code: "konami" }. Validated server-side so the code string is the
 *      single source of truth.
 *
 *   2. A deep secret pass-phrase, sent as { passphrase: "..." }. The phrase
 *      lives in an env var (COMPETITION_PASSPHRASE) so it isn't in the repo.
 *
 * On success the user's `unlocks` array gains "competition", which the STEP
 * API checks before serving questions. The unlock persists across sessions.
 */

const KONAMI = 'konami';
const COMPETITION_KEY = 'competition';

const Body = z.object({
  code: z.string().max(50).optional(),
  passphrase: z.string().max(200).optional(),
});

// POST /api/unlock — attempt an unlock.
export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let parsed;
  try {
    parsed = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request' },
      { status: 400 }
    );
  }

  const ok =
    parsed.code === KONAMI ||
    (parsed.passphrase &&
      process.env.COMPETITION_PASSPHRASE &&
      parsed.passphrase === process.env.COMPETITION_PASSPHRASE);

  if (!ok) {
    return NextResponse.json({ unlocked: false }, { status: 200 });
  }

  // Add the unlock key if not already present (avoid duplicates).
  const existing = await prisma.user.findUnique({
    where: { id: user.id },
    select: { unlocks: true },
  });
  const current = existing?.unlocks ?? [];
  if (!current.includes(COMPETITION_KEY)) {
    await prisma.user.update({
      where: { id: user.id },
      data: { unlocks: { push: COMPETITION_KEY } },
    });
  }

  return NextResponse.json({ unlocked: true, key: COMPETITION_KEY });
}

// GET /api/unlock — check the current user's unlocks (for the client to know
// whether to show the competition vault).
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const fresh = await prisma.user.findUnique({
    where: { id: user.id },
    select: { unlocks: true },
  });
  const unlocks = fresh?.unlocks ?? [];
  return NextResponse.json({
    competition: unlocks.includes(COMPETITION_KEY),
    unlocks,
  });
}
