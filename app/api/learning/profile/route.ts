import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

const ProfileBody = z.object({
  examDate: z.string().date().nullable().optional(),
  weeklyStudyMinutes: z.number().int().min(60).max(2520).optional(),
  targetGrade: z.string().trim().min(1).max(12).optional(),
  board: z.string().trim().max(40).nullable().optional(),
  qualification: z.string().trim().max(80).nullable().optional(),
  level: z.string().trim().max(40).nullable().optional(),
  subjectCode: z.string().trim().max(40).nullable().optional(),
  currentLevel: z.string().trim().max(80).nullable().optional(),
  recentResult: z.string().trim().max(120).nullable().optional(),
  availability: z.record(z.string(), z.number().int().min(0).max(360)).optional(),
});

function defaultProfile(userId: string) {
  return {
    userId,
    weeklyStudyMinutes: 300,
    targetGrade: 'A',
    availability: { 0: 45, 1: 45, 2: 45, 3: 45, 4: 45, 5: 60, 6: 60 },
  };
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const profile = await prisma.learningProfile.upsert({
    where: { userId: user.id },
    create: defaultProfile(user.id),
    update: {},
  });

  return NextResponse.json({ profile });
}

export async function PUT(req: Request) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: z.infer<typeof ProfileBody>;
  try {
    body = ProfileBody.parse(await req.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid profile' },
      { status: 400 }
    );
  }

  const profile = await prisma.learningProfile.upsert({
    where: { userId: user.id },
    create: {
      ...defaultProfile(user.id),
      examDate: body.examDate ? new Date(`${body.examDate}T12:00:00.000Z`) : null,
      weeklyStudyMinutes: body.weeklyStudyMinutes ?? 300,
      targetGrade: body.targetGrade ?? 'A',
      board: body.board ?? null,
      qualification: body.qualification ?? null,
      level: body.level ?? null,
      subjectCode: body.subjectCode ?? null,
      currentLevel: body.currentLevel ?? null,
      recentResult: body.recentResult ?? null,
      availability: (body.availability ?? defaultProfile(user.id).availability) as Prisma.InputJsonValue,
    },
    update: {
      ...(body.examDate !== undefined && {
        examDate: body.examDate ? new Date(`${body.examDate}T12:00:00.000Z`) : null,
      }),
      ...(body.weeklyStudyMinutes !== undefined && { weeklyStudyMinutes: body.weeklyStudyMinutes }),
      ...(body.targetGrade !== undefined && { targetGrade: body.targetGrade }),
      ...(body.board !== undefined && { board: body.board }),
      ...(body.qualification !== undefined && { qualification: body.qualification }),
      ...(body.level !== undefined && { level: body.level }),
      ...(body.subjectCode !== undefined && { subjectCode: body.subjectCode }),
      ...(body.currentLevel !== undefined && { currentLevel: body.currentLevel }),
      ...(body.recentResult !== undefined && { recentResult: body.recentResult }),
      ...(body.availability !== undefined && {
        availability: body.availability as Prisma.InputJsonValue,
      }),
    },
  });

  return NextResponse.json({ profile });
}
