import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getSyncUser } from '@/lib/sync-auth';
import { indexCloudDocument, refreshRagIndex } from '@/lib/rag-index';

export const dynamic = 'force-dynamic';

/**
 * GET /api/sync/documents
 *   ?since=<iso>   only documents updated after this timestamp (delta sync)
 *   ?clientId=<id> a single document
 *
 * Returns the caller's cloud documents (excluding hard-deleted rows).
 */
export async function GET(req: NextRequest) {
  const user = await getSyncUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const since = searchParams.get('since');
  const clientId = searchParams.get('clientId');

  const where: Record<string, unknown> = { ownerId: user.id };
  if (since) where.updatedAt = { gt: new Date(since) };
  if (clientId) where.clientId = clientId;

  const docs = await prisma.cloudDocument.findMany({
    where,
    orderBy: { updatedAt: 'asc' },
  });

  return NextResponse.json({
    documents: docs.map((d) => ({
      id: d.id,
      clientId: d.clientId,
      title: d.title,
      format: d.format,
      body: d.body,
      blocks: d.blocks,
      revision: d.revision,
      deletedAt: d.deletedAt,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
    serverTime: new Date().toISOString(),
  });
}

const UpsertBody = z.object({
  clientId: z.string().min(1).max(200),
  title: z.string().max(500).optional(),
  format: z.enum(['hybrid', 'markdown']).optional(),
  body: z.string().max(2_000_000).optional(),
  blocks: z.unknown().optional(), // validated loosely — any JSON
  baseRevision: z.number().int().nonnegative().optional(), // optimistic concurrency
  deletedAt: z.string().nullable().optional(),
});

/**
 * POST /api/sync/documents
 *   Upsert a single document. Last-write-wins with optimistic-concurrency:
 *   if `baseRevision` is provided and doesn't match the server's current
 *   revision, returns 409 so the client can re-pull and merge.
 *
 * Returns the upserted document (with its new revision).
 */
export async function POST(req: NextRequest) {
  const user = await getSyncUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let parsed;
  try {
    parsed = UpsertBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid request' },
      { status: 400 }
    );
  }

  // Look up the existing doc for this (owner, clientId).
  const existing = await prisma.cloudDocument.findUnique({
    where: { ownerId_clientId: { ownerId: user.id, clientId: parsed.clientId } },
  });

  // Optimistic concurrency check.
  if (existing && parsed.baseRevision !== undefined && parsed.baseRevision !== existing.revision) {
    return NextResponse.json(
      {
        error: 'Conflict: server has a newer revision',
        serverRevision: existing.revision,
        serverUpdatedAt: existing.updatedAt,
        serverDocument: {
          id: existing.id,
          clientId: existing.clientId,
          title: existing.title,
          format: existing.format,
          body: existing.body,
          blocks: existing.blocks,
          revision: existing.revision,
          updatedAt: existing.updatedAt,
        },
      },
      { status: 409 }
    );
  }

  const newRevision = (existing?.revision ?? 0) + 1;

  // Normalise blocks: undefined = leave unchanged, null = JsonNull, else JSON.
  const blocksValue =
    parsed.blocks !== undefined
      ? (parsed.blocks === null ? Prisma.JsonNull : (parsed.blocks as Prisma.InputJsonValue))
      : (existing?.blocks ?? Prisma.JsonNull);

  const data = {
    title: parsed.title ?? existing?.title ?? 'Untitled',
    format: parsed.format ?? existing?.format ?? 'hybrid',
    body: parsed.body ?? existing?.body ?? '',
    blocks: blocksValue,
    revision: newRevision,
    deletedAt: parsed.deletedAt === undefined ? existing?.deletedAt ?? null : parsed.deletedAt ? new Date(parsed.deletedAt) : null,
  };

  const doc = await prisma.cloudDocument.upsert({
    where: { ownerId_clientId: { ownerId: user.id, clientId: parsed.clientId } },
    create: {
      ownerId: user.id,
      clientId: parsed.clientId,
      ...data,
    },
    update: data,
  });
  await refreshRagIndex(`cloud-document:${doc.id}`, () => indexCloudDocument(doc.id));

  return NextResponse.json({
    document: {
      id: doc.id,
      clientId: doc.clientId,
      title: doc.title,
      format: doc.format,
      body: doc.body,
      blocks: doc.blocks,
      revision: doc.revision,
      deletedAt: doc.deletedAt,
      updatedAt: doc.updatedAt,
    },
  });
}

/**
 * DELETE /api/sync/documents?clientId=<id>
 *   Soft-deletes the document (sets deletedAt) so other clients learn about
 *   the deletion via delta sync. Hard purge happens later via a janitor.
 */
export async function DELETE(req: NextRequest) {
  const user = await getSyncUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const clientId = searchParams.get('clientId');
  if (!clientId) return NextResponse.json({ error: 'clientId required' }, { status: 400 });

  const existing = await prisma.cloudDocument.findUnique({
    where: { ownerId_clientId: { ownerId: user.id, clientId } },
  });
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const doc = await prisma.cloudDocument.update({
    where: { id: existing.id },
    data: { deletedAt: new Date(), revision: existing.revision + 1 },
  });
  await refreshRagIndex(`cloud-document:${doc.id}`, () => indexCloudDocument(doc.id));

  return NextResponse.json({ ok: true, clientId, revision: doc.revision, deletedAt: doc.deletedAt });
}
