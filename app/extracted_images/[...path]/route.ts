import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { serveProtectedAsset } from '@/lib/storage/protected-asset';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /extracted_images/**
 *
 * Diagram images extracted from past papers, referenced by `/api/questions`
 * and `/api/images`. Previously static files under `public/extracted_images/`.
 *
 * Session-gated, like `/uploads/**`: both of the routes that hand out these
 * URLs already require a session, so serving the bytes anonymously left the
 * paper corpus readable to anyone who obtained a filename. The filenames are
 * derived from paper stems (`9702_s2024_2v1_q3.png`), which makes them far
 * more guessable than the UUIDs under `/uploads/`.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return serveProtectedAsset('extracted_images', path, {
    getSession: () => getServerSession(authOptions),
  });
}
