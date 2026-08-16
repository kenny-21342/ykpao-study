import { serveStoredObject } from '@/lib/storage/serve';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /extracted_images/**
 *
 * Diagram images extracted from past papers, referenced by `/api/questions`
 * and `/api/images`. Previously static files under `public/extracted_images/`.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return serveStoredObject(['extracted_images', ...path]);
}
