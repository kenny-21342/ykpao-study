import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { serveProtectedAsset } from '@/lib/storage/protected-asset';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /step-images/**
 *
 * Images attached to STEP questions by `scripts/step-data/load-step.ts`.
 * Previously static files under `public/step-images/`.
 *
 * Session-gated, like `/uploads/**`: these are question and worked-solution
 * figures for the cohort, and their names come straight from the question
 * label (`Spec-S1-Q1.png`), so they are trivially enumerable.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return serveProtectedAsset('step-images', path, {
    getSession: () => getServerSession(authOptions),
  });
}
