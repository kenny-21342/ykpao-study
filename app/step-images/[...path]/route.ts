import { serveStoredObject } from '@/lib/storage/serve';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /step-images/**
 *
 * Images attached to STEP questions by `scripts/step-data/load-step.ts`.
 * Previously static files under `public/step-images/`.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return serveStoredObject(['step-images', ...path]);
}
