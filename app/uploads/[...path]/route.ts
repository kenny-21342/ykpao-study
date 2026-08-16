import { serveStoredObject } from '@/lib/storage/serve';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /uploads/**
 *
 * Serves user and admin uploads from the object store. Access matches what the
 * static `public/uploads/` directory did before: anyone holding the URL can
 * fetch it. The filenames are UUIDs, so they are unguessable, but they are not
 * a permission check — see the note in README.md.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  return serveStoredObject(['uploads', ...path]);
}
