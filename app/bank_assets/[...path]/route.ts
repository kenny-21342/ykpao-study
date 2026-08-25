import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { serveProtectedAsset } from '@/lib/storage/protected-asset';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /bank_assets/**
 *
 * Question-bank crops: the rendered image of one question, one mark scheme, or
 * one figure, content-addressed by sha256 (`bank_assets/<ab>/<sha256>.png`).
 *
 * Session-gated like the other asset prefixes. These are cut straight out of
 * copyrighted past papers, and a crop-first bank serves many per page — which
 * is why the gate reads the JWT rather than the database, as documented in
 * lib/storage/protected-asset.ts.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return serveProtectedAsset('bank_assets', path, {
    getSession: () => getServerSession(authOptions),
  });
}
