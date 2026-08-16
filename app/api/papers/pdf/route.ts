import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { contentDisposition, paperDownloadUrl, readPaperPdf } from '@/lib/paper-files';
import { getSessionUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const PDF_FILENAME_RE = /^[a-z0-9][a-z0-9_-]*\.pdf$/i;

/**
 * Look a paper up by filename.
 *
 * Kept for existing callers in the question database. Filenames are only unique
 * for CAIE papers -- IB reuses them across sessions -- so new callers should use
 * `/api/papers/[id]/file` instead.
 */
export async function GET(request: NextRequest) {
  // Same gate as /api/papers/[id]/file. Without it this route is an
  // unauthenticated mirror of the whole paper corpus, and the filenames are
  // guessable (`9702_s24_qp_21.pdf`).
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const filename = request.nextUrl.searchParams.get('filename')?.trim();

  if (!filename || !PDF_FILENAME_RE.test(filename)) {
    return NextResponse.json({ error: 'A complete PDF filename is required' }, { status: 400 });
  }

  const paper = await prisma.pastPaper.findFirst({
    where: {
      filename: {
        equals: filename,
        mode: 'insensitive',
      },
    },
    orderBy: { id: 'asc' },
    select: {
      filename: true,
      filepath: true,
    },
  });

  if (!paper) {
    return NextResponse.json({ error: 'Paper PDF not found' }, { status: 404 });
  }

  // See /api/papers/[id]/file — redirect to the object store when we can,
  // rather than buffering a multi-megabyte PDF through the function.
  const signedUrl = await paperDownloadUrl(paper.filepath, {
    filename: paper.filename,
    download: false,
  });
  if (signedUrl) {
    return NextResponse.redirect(signedUrl, {
      status: 307,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  const file = await readPaperPdf(paper.filepath);
  if (!file) {
    return NextResponse.json({ error: 'Paper PDF not found' }, { status: 404 });
  }

  return new Response(new Uint8Array(file.bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition(paper.filename, false),
      'Content-Length': String(file.size),
      'Cache-Control': 'private, max-age=300',
    },
  });
}
