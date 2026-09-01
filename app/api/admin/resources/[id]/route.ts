import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { reportError } from '@/lib/error-reporting';
import { indexSchoolResource, refreshRagIndex } from '@/lib/rag-index';
import {
  deleteSchoolResource,
  replaceSchoolResourceFile,
} from '@/lib/school-resources';

export const dynamic = 'force-dynamic';

const replacementFileSchema = z.object({
  fileUrl: z.string().min(1),
  fileName: z.string().min(1).max(200),
  fileSize: z.number().int().nonnegative().optional(),
  mimeType: z.string().max(100).optional(),
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  subject: z.string().max(100).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  fileName: z.string().trim().min(1).max(200).optional(),
  replacementFile: replacementFileSchema.optional(),
});

/**
 * PATCH /api/admin/resources/[id]
 * Edit a school resource's metadata and/or swap its file.
 *
 * Metadata and replacement are one atomic request from the dialog's point of
 * view, but applied in a fixed order: the file swap first (it validates and
 * purges), then the metadata. A failing swap leaves the metadata untouched,
 * so a save that goes wrong never half-applies.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { title, description, subject, category, fileName, replacementFile } = parsed.data;

  try {
    let resource;
    if (replacementFile) {
      const result = await replaceSchoolResourceFile(id, replacementFile);
      if (result.status === 'not-found') {
        return NextResponse.json({ error: 'Resource not found' }, { status: 404 });
      }
      if (result.status === 'bad-url') {
        return NextResponse.json({ error: 'fileUrl must point to a local /uploads/ path' }, { status: 400 });
      }
      resource = result.resource;
    }

    // Build only the provided metadata fields. Empty subject/category clear
    // the column (null), matching what POST does with blank inputs.
    const data: Record<string, unknown> = {};
    if (title !== undefined) data.title = title;
    if (description !== undefined) data.description = description.trim();
    if (subject !== undefined) data.subject = subject?.trim() || null;
    if (category !== undefined) data.category = category?.trim() || null;
    // A swap already set fileName from the uploaded file. The edit dialog
    // prefills this field with the *previous* file's name and always sends it,
    // so honouring it here relabelled the new file with the old one's name —
    // students downloaded one document under another's title.
    if (fileName !== undefined && !replacementFile) data.fileName = fileName;

    const hasMetadata = Object.keys(data).length > 0;
    if (!replacementFile && !hasMetadata) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
    }

    // Skip the write when only a file was swapped: `data` is empty there, and
    // returning the pre-metadata row meant a request that both swapped the file
    // and edited the title answered with the old title.
    if (hasMetadata) {
      resource = await prisma.schoolResource.update({
        where: { id },
        data,
        include: { uploader: { select: { id: true, name: true, image: true } } },
      });
      // Title, description and fileName are exactly what the RAG index stores.
      await refreshRagIndex(`resource:${id}`, () => indexSchoolResource(id));
    }

    return NextResponse.json({ resource });
  } catch (error) {
    // A missing id reaching prisma.update surfaces as P2025; report and 404.
    // This said so already but answered 500, so editing a resource another tab
    // had deleted looked like a server fault rather than a stale page.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2025') {
      return NextResponse.json({ error: 'Resource not found' }, { status: 404 });
    }
    console.error('[admin/resources] update failed:', error);
    await reportError(error, { routePath: '/api/admin/resources/[id]', source: 'route' });
    return NextResponse.json({ error: 'Failed to update resource' }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/resources/[id]
 * Delete the row, its stored file, and its RAG index entry.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { id } = await params;
  try {
    const result = await deleteSchoolResource(id);
    if (result.status === 'not-found') {
      return NextResponse.json({ error: 'Resource not found' }, { status: 404 });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[admin/resources] delete failed:', error);
    await reportError(error, { routePath: '/api/admin/resources/[id]', source: 'route' });
    return NextResponse.json({ error: 'Failed to delete resource' }, { status: 500 });
  }
}
