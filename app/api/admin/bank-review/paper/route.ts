import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { contentDisposition, paperDownloadUrl, readPaperPdf } from '@/lib/paper-files';
import { parseEntityId } from '@/lib/query-params';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!(await requireAdmin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const id = parseEntityId(req.nextUrl.searchParams.get('id'));
  if (id === null) return NextResponse.json({ error: 'Invalid paper id' }, { status: 400 });

  const paper = await prisma.bankPaper.findUnique({ where: { id }, select: { sourcePath: true } });
  if (!paper) return NextResponse.json({ error: 'Paper not found' }, { status: 404 });

  // The extraction store retains absolute local paths. Storage keys start at
  // pdf_extraction/, so discard the machine-specific prefix before validation.
  const normalized = paper.sourcePath.replace(/\\/g, '/');
  const marker = 'pdf_extraction/';
  const at = normalized.indexOf(marker);
  const storedPath = at >= 0 ? normalized.slice(at) : normalized;
  const filename = storedPath.split('/').at(-1) ?? 'paper.pdf';
  if (!filename.toLowerCase().endsWith('.pdf')) return NextResponse.json({ error: 'Paper PDF unavailable' }, { status: 404 });

  const signedUrl = await paperDownloadUrl(storedPath, { filename, download: false });
  if (signedUrl) return NextResponse.redirect(signedUrl, { status: 307, headers: { 'Cache-Control': 'private, no-store' } });

  const file = await readPaperPdf(storedPath);
  if (!file) return NextResponse.json({ error: 'Paper PDF unavailable' }, { status: 404 });
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition(filename, false),
      'Content-Length': String(file.size),
      'Cache-Control': 'private, no-store',
    },
  });
}
