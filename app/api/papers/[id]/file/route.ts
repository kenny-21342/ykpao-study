import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getSessionUser } from '@/lib/auth';
import { contentDisposition, paperDownloadUrl, readPaperPdf } from '@/lib/paper-files';
import { parseEntityId } from '@/lib/query-params';

export const dynamic = 'force-dynamic';

/**
 * Stream a past paper PDF by id.
 *
 * Papers must be addressed by id rather than filename: IB filenames repeat
 * across sessions (the same `Biology_paper_1__TZ1_HL.pdf` exists in many
 * years), so a filename lookup would serve the wrong paper.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  // `parseEntityId` also rejects values too large for the column: a finite
  // 1e20 passes Number.isInteger and then fails inside Prisma as a 500.
  const paperId = parseEntityId(id);
  if (paperId === null) {
    return NextResponse.json({ error: 'Invalid paper id' }, { status: 400 });
  }

  const paper = await prisma.pastPaper.findUnique({
    where: { id: paperId },
    select: { filename: true, filepath: true },
  });

  if (!paper) {
    return NextResponse.json({ error: 'Paper not found' }, { status: 404 });
  }

  const download = request.nextUrl.searchParams.get('download') === '1';

  // Where the store can issue one, hand the browser a direct URL instead of
  // proxying the bytes: past papers routinely exceed the ~4.5 MB cap on a
  // serverless function response, and buffering them wastes memory besides.
  const signedUrl = await paperDownloadUrl(paper.filepath, {
    filename: paper.filename,
    download,
  });
  if (signedUrl) {
    return NextResponse.redirect(signedUrl, {
      status: 307,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  }

  const file = await readPaperPdf(paper.filepath);
  if (!file) {
    return NextResponse.json({ error: 'Paper PDF is unavailable' }, { status: 404 });
  }

  return new Response(new Uint8Array(file.bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition(paper.filename, download),
      'Content-Length': String(file.size),
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
