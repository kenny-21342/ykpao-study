/**
 * A student's scratch/working-out drawing for one question.
 *
 * Kept in its own table rather than a column on the three attempt tables:
 * a scratchpad has to exist and autosave *before* an attempt row does (while
 * the student is still working), and it is shared across all three
 * question-taking surfaces (mock exam, practice, bank) even though each has
 * its own attempt table. Exactly one of the three question refs is set on
 * any given row, mirroring the questionId/bankQuestionId split already used
 * on MockExamItem for the same "three tables, one foreign key" constraint.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const RefQuery = z.object({
  pastPaperQuestionId: z.coerce.number().int().positive().optional(),
  bankQuestionId: z.coerce.number().int().positive().optional(),
  mockExamItemId: z.string().min(1).optional(),
});

function questionRefWhere(ref: z.infer<typeof RefQuery>) {
  const refs = [ref.pastPaperQuestionId, ref.bankQuestionId, ref.mockExamItemId].filter(
    (value) => value !== undefined,
  );
  if (refs.length !== 1) return null;
  return {
    pastPaperQuestionId: ref.pastPaperQuestionId ?? null,
    bankQuestionId: ref.bankQuestionId ?? null,
    mockExamItemId: ref.mockExamItemId ?? null,
  };
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const parsed = RefQuery.safeParse({
    pastPaperQuestionId: searchParams.get('pastPaperQuestionId') ?? undefined,
    bankQuestionId: searchParams.get('bankQuestionId') ?? undefined,
    mockExamItemId: searchParams.get('mockExamItemId') ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: 'Invalid question reference' }, { status: 400 });

  const where = questionRefWhere(parsed.data);
  if (!where) return NextResponse.json({ error: 'Exactly one question reference is required' }, { status: 400 });

  const scratchpad = await prisma.questionScratchpad.findFirst({
    where: { userId: user.id, ...where },
  });

  return NextResponse.json({ scratchpad });
}

const PutBody = z.object({
  pastPaperQuestionId: z.number().int().positive().optional(),
  bankQuestionId: z.number().int().positive().optional(),
  mockExamItemId: z.string().min(1).optional(),
  // Shape is DrawingCanvas's own { strokes, textBoxes } -- opaque to the
  // server, which only stores and returns it.
  strokesJson: z.unknown(),
  previewImageUrl: z.string().max(2000).nullable().optional(),
});

export async function PUT(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = PutBody.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

  const where = questionRefWhere(parsed.data);
  if (!where) return NextResponse.json({ error: 'Exactly one question reference is required' }, { status: 400 });

  // Upsert keyed on whichever of the three unique constraints matches --
  // Prisma has no "upsert on one of several unique indexes" primitive, so
  // find-then-create/update instead of relying on `upsert`'s single `where`.
  const existing = await prisma.questionScratchpad.findFirst({ where: { userId: user.id, ...where } });

  const scratchpad = existing
    ? await prisma.questionScratchpad.update({
        where: { id: existing.id },
        data: {
          strokesJson: parsed.data.strokesJson as unknown as Prisma.InputJsonValue,
          previewImageUrl: parsed.data.previewImageUrl,
        },
      })
    : await prisma.questionScratchpad.create({
        data: {
          userId: user.id,
          ...where,
          strokesJson: parsed.data.strokesJson as unknown as Prisma.InputJsonValue,
          previewImageUrl: parsed.data.previewImageUrl,
        },
      });

  return NextResponse.json({ scratchpad });
}
