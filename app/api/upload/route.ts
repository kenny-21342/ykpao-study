import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import path from 'path';
import { randomUUID } from 'crypto';
import { getStorage, KEY_PREFIX } from '@/lib/storage';
import { reportError } from '@/lib/error-reporting';
import { prisma } from '@/lib/prisma';
import { resolveFolderPath } from '@/lib/school-resources';

export const dynamic = 'force-dynamic';

// Allow-list by extension -> MIME -> subfolder. Images are served from
// /uploads/images/*, documents from /uploads/files/*. Keeping the lists
// explicit (rather than trusting the declared MIME) blocks polyglot tricks.
const IMAGE_TYPES = new Map<string, string>([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);
const DOC_TYPES = new Map<string, string>([
  ['.pdf', 'application/pdf'],
  ['.doc', 'application/msword'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xls', 'application/vnd.ms-excel'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
]);

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

type UploadKind = 'image' | 'file';

export async function POST(req: NextRequest) {
  // getSessionUser() rather than getServerSession(): it is the chokepoint that
  // enforces bans and credential-fingerprint revocation. The gate was on
  // `session.user.email` purely as a proof of sign-in — nothing downstream uses
  // the address — so resolving the row instead costs one query and closes the
  // hole where a banned or reset-away session could still upload.
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `File too large (max ${MAX_BYTES / (1024 * 1024)} MB)` },
        { status: 413 }
      );
    }

    const ext = path.extname(file.name).toLowerCase();
    let kind: UploadKind;
    let expectedMime: string;

    if (IMAGE_TYPES.has(ext)) {
      kind = 'image';
      expectedMime = IMAGE_TYPES.get(ext)!;
    } else if (DOC_TYPES.has(ext)) {
      kind = 'file';
      expectedMime = DOC_TYPES.get(ext)!;
    } else {
      return NextResponse.json(
        { error: `File type "${ext || 'unknown'}" is not allowed` },
        { status: 400 }
      );
    }

    // Cross-check declared MIME if the browser supplied one.
    if (file.type && file.type !== expectedMime) {
      return NextResponse.json(
        { error: `MIME type "${file.type}" does not match extension "${ext}"` },
        { status: 400 }
      );
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Magic-number sanity checks for the formats that have reliable ones.
    if (kind === 'image') {
      if (!isImageBuffer(buffer)) {
        return NextResponse.json(
          { error: 'File does not appear to be a valid image' },
          { status: 400 }
        );
      }
    } else if (ext === '.pdf') {
      if (buffer.length < 5 || buffer.slice(0, 5).toString('latin1') !== '%PDF-') {
        return NextResponse.json(
          { error: 'File does not appear to be a valid PDF' },
          { status: 400 }
        );
      }
    }

    const subDir = kind === 'image' ? 'images' : 'files';
    // Resource uploads may name an existing destination or supply the relative
    // path from a directory picker. Other uploads retain their original URL.
    const requestedFolderId = formData.get('resourceFolderId');
    const requestedFolderPath = formData.get('resourceFolderPath');
    const requestedParentId = formData.get('resourceParentFolderId');
    if ((requestedFolderId !== null && typeof requestedFolderId !== 'string') ||
        (requestedFolderPath !== null && typeof requestedFolderPath !== 'string') ||
        (requestedParentId !== null && typeof requestedParentId !== 'string') ||
        (requestedFolderId && requestedFolderPath)) {
      return NextResponse.json({ error: 'Invalid resource folder' }, { status: 400 });
    }
    let folderId: string | null = null;
    if (typeof requestedFolderId === 'string' && requestedFolderId) {
      const folder = await prisma.schoolResourceFolder.findUnique({
        where: { id: requestedFolderId }, select: { id: true },
      });
      if (!folder) return NextResponse.json({ error: 'Resource folder not found' }, { status: 404 });
      folderId = folder.id;
    } else if (typeof requestedFolderPath === 'string' && requestedFolderPath) {
      let parentId: string | null = null;
      if (typeof requestedParentId === 'string' && requestedParentId) {
        const parent = await prisma.schoolResourceFolder.findUnique({ where: { id: requestedParentId }, select: { id: true } });
        if (!parent) return NextResponse.json({ error: 'Resource parent folder not found' }, { status: 404 });
        parentId = parent.id;
      }
      folderId = await resolveFolderPath(requestedFolderPath, parentId, user.id);
    }

    // Strip the user's original filename and use a UUID + validated ext so
    // we never write an attacker-controlled string to storage.
    const uniqueFilename = `${randomUUID()}${ext}`;
    const relativeKey = folderId
      ? `${subDir}/resources/${folderId}/${uniqueFilename}`
      : `${subDir}/${uniqueFilename}`;
    const key = `${KEY_PREFIX.uploads}/${relativeKey}`;
    await getStorage().put(key, buffer, {
      contentType: expectedMime,
      // Content-addressed by UUID, so the object at this key never changes.
      cacheControl: 'public, max-age=31536000, immutable',
    });

    // The stored URL keeps its historical shape. `/uploads/**` is served by
    // app/uploads/[...path]/route.ts, which resolves it through the same
    // object store — so existing database rows keep working unchanged.
    const publicUrl = `/uploads/${relativeKey}`;

    return NextResponse.json({
      success: true,
      kind,
      fileUrl: publicUrl,
      fileName: file.name,
      fileSize: file.size,
      mimeType: expectedMime,
      resourceFolderId: folderId,
    });
  } catch (error) {
    // Never echo the underlying error: it carries storage keys, bucket names
    // and filesystem paths.
    console.error('[api/upload] failed:', error);
    await reportError(error, { routePath: '/api/upload', source: 'route' });
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}

// Check common image magic numbers.
function isImageBuffer(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // WEBP: "RIFF"...."WEBP"
  if (
    buf.length >= 12 &&
    buf.slice(0, 4).toString('latin1') === 'RIFF' &&
    buf.slice(8, 12).toString('latin1') === 'WEBP'
  ) {
    return true;
  }
  return false;
}
