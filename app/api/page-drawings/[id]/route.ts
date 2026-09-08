import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canEditPage, getPageAccess } from '@/lib/page-access';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/** Load a drawing and check the requester can at least view its page. */
async function loadWithAccess(id: string, userId: string) {
  const drawing = await prisma.pageDrawing.findUnique({ where: { id } });
  if (!drawing) return null;
  const access = await getPageAccess(drawing.pageId, userId);
  if (!access) return null;
  return { drawing, access };
}

export async function GET(_req: Request, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const found = await loadWithAccess(id, user.id);
  if (!found) return NextResponse.json({ error: 'Drawing not found' }, { status: 404 });
  return NextResponse.json({ drawing: found.drawing });
}

const PatchBody = z.object({
  strokesJson: z.unknown(),
  thumbnailUrl: z.string().min(1).max(2000),
  width: z.number().int().positive().max(8000).optional(),
  height: z.number().int().positive().max(8000).optional(),
});

export async function PATCH(req: Request, { params }: RouteContext) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;

  const found = await loadWithAccess(id, user.id);
  if (!found) return NextResponse.json({ error: 'Drawing not found' }, { status: 404 });
  if (!canEditPage(found.access.role)) {
    return NextResponse.json({ error: 'You cannot edit this page' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = PatchBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

  const drawing = await prisma.pageDrawing.update({
    where: { id },
    data: {
      strokesJson: parsed.data.strokesJson as unknown as Prisma.InputJsonValue,
      thumbnailUrl: parsed.data.thumbnailUrl,
      ...(parsed.data.width !== undefined && { width: parsed.data.width }),
      ...(parsed.data.height !== undefined && { height: parsed.data.height }),
    },
  });

  return NextResponse.json({ drawing });
}
