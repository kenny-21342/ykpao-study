import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import path from 'path';
import { randomUUID } from 'crypto';
import { getStorage, KEY_PREFIX } from '@/lib/storage';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

const ALLOWED_EXT = new Map<string, string>([
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.zip', 'application/zip'],
]);

/**
 * POST /api/admin/upload
 * Admin-only generic file upload. Writes to public/uploads/files/<uuid>.<ext>
 * Returns { fileUrl, fileName, fileSize, mimeType }.
 *
 * Body: multipart/form-data with a `file` field.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: `File too large (max ${MAX_BYTES / (1024 * 1024)} MB)` }, { status: 413 });
    }

    const ext = path.extname(file.name).toLowerCase();
    const expectedMime = ALLOWED_EXT.get(ext);
    if (!expectedMime) {
      return NextResponse.json({ error: `File type "${ext}" is not allowed.` }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Validate magic number for PDF.
    if (ext === '.pdf' && !buffer.subarray(0, 5).toString('ascii').startsWith('%PDF')) {
      return NextResponse.json({ error: 'File does not appear to be a valid PDF.' }, { status: 400 });
    }

    const filename = `${randomUUID()}${ext}`;
    await getStorage().put(`${KEY_PREFIX.uploads}/files/${filename}`, buffer, {
      contentType: expectedMime,
      cacheControl: 'public, max-age=31536000, immutable',
    });

    return NextResponse.json({
      fileUrl: `/uploads/files/${filename}`,
      fileName: file.name,
      fileSize: file.size,
      mimeType: expectedMime,
    });
  } catch (err) {
    // The underlying error carries storage keys and bucket names; log it,
    // return a fixed message.
    console.error('[api/admin/upload] failed:', err);
    await reportError(err, { routePath: '/api/admin/upload', source: 'route' });
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
