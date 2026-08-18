import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { serveProtectedAsset } from '@/lib/storage/protected-asset';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /uploads/**
 *
 * Serves user and admin uploads from the object store. Uploads contain student
 * work and are therefore session-gated; UUID filenames are not treated as an
 * access-control mechanism. The S3 driver still redirects authenticated users
 * to a short-lived signed URL, so large files do not pass through this route.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return serveProtectedAsset('uploads', path, {
    getSession: () => getServerSession(authOptions),
  });
}
