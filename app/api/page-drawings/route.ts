/**
 * Create a new embedded drawing on a note page.
 *
 * A drawing is created once, up front, so the `drawingBlock` TipTap node can
 * reference it by id from the moment it's inserted -- the alternative
 * (create-on-first-save) would leave a node in the document with nothing to
 * click on if the user closed the page before saving once.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { canEditPage, getPageAccess } from '@/lib/page-access';

export const dynamic = 'force-dynamic';

const CreateBody = z.object({
  pageId: z.string().min(1),
  // Shape is DrawingCanvas's own { strokes, textBoxes } -- opaque to the
  // server, which only stores and returns it.
  strokesJson: z.unknown(),
  thumbnailUrl: z.string().min(1).max(2000),
  width: z.number().int().positive().max(8000),
  height: z.number().int().positive().max(8000),
});

export async function POST(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

  const access = await getPageAccess(parsed.data.pageId, user.id);
  if (!access) return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  if (!canEditPage(access.role)) {
    return NextResponse.json({ error: 'You cannot edit this page' }, { status: 403 });
  }

  const drawing = await prisma.pageDrawing.create({
    data: {
      pageId: parsed.data.pageId,
      createdById: user.id,
      strokesJson: parsed.data.strokesJson as unknown as Prisma.InputJsonValue,
      thumbnailUrl: parsed.data.thumbnailUrl,
      width: parsed.data.width,
      height: parsed.data.height,
    },
  });

  return NextResponse.json({ drawing }, { status: 201 });
}
