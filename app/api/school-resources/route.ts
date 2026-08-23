import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { getSessionUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { indexSchoolResource, refreshRagIndex } from '@/lib/rag-index';
import { resolveCourseScope } from '@/lib/course-scope';
import { LearnerContextError } from '@/lib/learner-context';
import { reportError } from '@/lib/error-reporting';

export const dynamic = 'force-dynamic';

type SortField = 'createdAt' | 'updatedAt' | 'title' | 'fileName' | 'downloads' | 'fileSize';
const SORT_FIELDS = new Set<SortField>(['createdAt', 'updatedAt', 'title', 'fileName', 'downloads', 'fileSize']);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

// GET /api/school-resources — list (with optional subject/category/q filter)
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const subject = searchParams.get('subject')?.trim() || undefined;
    const category = searchParams.get('category')?.trim() || undefined;
    const q = searchParams.get('q')?.trim() || undefined;
    const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1);
    const requestedLimit = Number.parseInt(searchParams.get('limit') || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT;
    const limit = Math.min(MAX_LIMIT, Math.max(1, requestedLimit));
    const sortField = searchParams.get('sort') || 'createdAt';
    const sort = SORT_FIELDS.has(sortField as SortField) ? (sortField as SortField) : 'createdAt';
    const order = searchParams.get('order') === 'asc' ? 'asc' : 'desc';
    const user = await getSessionUser();
    // `resolveCourseScope` is a preference filter and says so -- it resolves
    // "enrolled" vs "all" without changing authorization, so it answers
    // `effectiveScope: 'all'` for a caller with no user id. That is correct for
    // what it does and wrong as the only thing between an anonymous request and
    // every row. Authorization belongs here, ahead of it. The `q` filter also matches
    // uploader name and email, so an open listing let anyone test whether an
    // address had an account here.
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const courseScope = await resolveCourseScope({ userId: user.id, scope: searchParams.get('scope'), courseId: searchParams.get('courseId') });

    const searchConditions: Prisma.SchoolResourceWhereInput[] = q ? [
      { title: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
      { fileName: { contains: q, mode: 'insensitive' } },
      { subject: { contains: q, mode: 'insensitive' } },
      { category: { contains: q, mode: 'insensitive' } },
      { uploader: { is: { name: { contains: q, mode: 'insensitive' } } } },
      { uploader: { is: { email: { contains: q, mode: 'insensitive' } } } },
    ] : [];

    const where: Prisma.SchoolResourceWhereInput = {
      ...(subject ? { subject: courseScope.effectiveScope === 'enrolled' && !courseScope.subjects.includes(subject) ? '__no_matching_enrolled_course__' : subject } : {}),
      ...(!subject && courseScope.effectiveScope === 'enrolled' ? { subject: { in: courseScope.subjects } } : {}),
      ...(category ? { category } : {}),
      ...(searchConditions.length > 0 ? { OR: searchConditions } : {}),
    };

    const orderBy: Prisma.SchoolResourceOrderByWithRelationInput[] = (() => {
      const primary = { [sort]: order } as Prisma.SchoolResourceOrderByWithRelationInput;
      if (sort === 'downloads' || sort === 'fileSize') {
        return [primary, { createdAt: 'desc' }];
      }
      return [primary, { createdAt: 'desc' }];
    })();

    const [total, resources, subjectRows, categoryRows] = await Promise.all([
      prisma.schoolResource.count({ where }),
      prisma.schoolResource.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          uploader: { select: { id: true, name: true, image: true } },
        },
      }),
      prisma.schoolResource.findMany({
        distinct: ['subject'],
        where: { subject: { not: null } },
        select: { subject: true },
        orderBy: { subject: 'asc' },
      }),
      prisma.schoolResource.findMany({
        distinct: ['category'],
        where: { category: { not: null } },
        select: { category: true },
        orderBy: { category: 'asc' },
      }),
    ]);

    return NextResponse.json({
      resources: resources.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        subject: r.subject,
        category: r.category,
        fileUrl: r.fileUrl,
        fileName: r.fileName,
        fileSize: r.fileSize,
        mimeType: r.mimeType,
        downloads: r.downloads,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        uploader: r.uploader,
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
      subjects: subjectRows.map((row) => row.subject).filter((value): value is string => Boolean(value)),
      categories: categoryRows.map((row) => row.category).filter((value): value is string => Boolean(value)),
      sort,
      order,
      pageSize: limit,
      scope: courseScope,
    });
  } catch (error) {
    if (error instanceof LearnerContextError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('Failed to list school resources:', error);
    await reportError(error, { routePath: '/api/school-resources', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list resources' },
      { status: 500 }
    );
  }
}

// POST /api/school-resources — upload metadata (file is uploaded separately
// via /api/upload, then this endpoint records the metadata row).
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) ?? {};
    const { title, description, subject, category, fileUrl, fileName, fileSize, mimeType } = body as {
      title?: string;
      description?: string;
      subject?: string;
      category?: string;
      fileUrl?: string;
      fileName?: string;
      fileSize?: number;
      mimeType?: string;
    };

    if (!title?.trim() || !fileUrl?.trim() || !fileName?.trim()) {
      return NextResponse.json(
        { error: 'title, fileUrl, and fileName are required' },
        { status: 400 }
      );
    }

    // Only accept files served from our own uploads dir to prevent
    // storing arbitrary external URLs.
    if (!fileUrl.startsWith('/uploads/') || fileUrl.includes('..')) {
      return NextResponse.json(
        { error: 'fileUrl must point to a local /uploads/ path' },
        { status: 400 }
      );
    }

    const resource = await prisma.schoolResource.create({
      data: {
        uploaderId: user.id,
        title: title.trim(),
        description: description?.trim() ?? '',
        subject: subject?.trim() || null,
        category: category?.trim() || null,
        fileUrl,
        fileName: fileName.trim().slice(0, 200),
        fileSize: typeof fileSize === 'number' ? fileSize : 0,
        mimeType: mimeType?.slice(0, 100) ?? '',
      },
      include: {
        uploader: { select: { id: true, name: true, image: true } },
      },
    });
    await refreshRagIndex(`resource:${resource.id}`, () => indexSchoolResource(resource.id));

    return NextResponse.json({ resource }, { status: 201 });
  } catch (error) {
    console.error('Failed to create school resource:', error);
    await reportError(error, { routePath: '/api/school-resources', source: 'route' });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create resource' },
      { status: 500 }
    );
  }
}
