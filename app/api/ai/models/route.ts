import { NextResponse } from 'next/server';

import { getSessionUser } from '@/lib/auth';
import { resolveAiCredentials } from '@/lib/ai-credentials';
import { loadSharedModels } from '@/lib/shared-models';

/**
 * Which shared models the tutor can offer right now.
 *
 * Signed-in only. The list itself is public information — it is read from a
 * status page anyone can open — but this also reports whether *this* student
 * is on the shared key, and there is no reason to hand an anonymous caller a
 * view of the platform's provider configuration.
 *
 * Returns nothing to choose from for a student using their own key: they chose
 * their model when they saved it and it is never substituted, so a picker
 * would offer a choice that changes nothing.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { status } = await resolveAiCredentials(user.id);
  if (status.source !== 'shared') {
    return NextResponse.json({ shared: false, models: [], configured: null });
  }

  const models = await loadSharedModels();
  return NextResponse.json(
    { shared: true, models, configured: status.textModel },
    {
      // A minute, matching the catalogue's own cache. The status page beats
      // once a minute, so a fresher answer than this would not be fresher.
      headers: { 'Cache-Control': 'private, max-age=60' },
    },
  );
}
