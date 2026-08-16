import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { aiLimiter } from '@/lib/rate-limit';
import { prisma } from '@/lib/prisma';
import { plainText } from '@/lib/learning';
import type { Prisma } from '@prisma/client';
import { resolveCourseScope } from '@/lib/course-scope';
import { LearnerContextError } from '@/lib/learner-context';

export const dynamic = 'force-dynamic';

/**
 * Vercel kills an invocation at the platform default (60s Hobby / 300s Pro)
 * regardless of what the request is doing. This one is pure Postgres — a
 * full-text scan across the corpus — but it is unbounded enough to be worth
 * a ceiling above the default.
 */
export const maxDuration = 60;

type SearchResult = {
  id: string;
  type: 'question' | 'markscheme' | 'note' | 'textbook' | 'resource';
  title: string;
  snippet: string;
  url: string;
  subject?: string | null;
  topic?: string | null;
};

export async function GET(req: NextRequest) {
  const searchParams = new URL(req.url).searchParams;
  const query = searchParams.get('q')?.trim().slice(0, 120) ?? '';
  if (query.length < 2) return NextResponse.json({ results: [], query });
  const user = await getSessionUser();
  // Search reaches across the past-paper corpus, shared notes, and resources.
  // It ran anonymously, which both exposed copyright-sensitive question text
  // to unauthenticated callers and gave them an unmetered fan-out of
  // full-text queries. Both callers (StudyCoach, NotesTextbook) are already
  // behind a sign-in gate, so requiring a session here changes nothing for
  // legitimate use.
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!(await aiLimiter.check(`search:${user.id}`))) {
    return NextResponse.json(
      { error: 'Too many searches. Please wait a moment and try again.' },
      { status: 429 }
    );
  }

  let courseScope;
  try {
    courseScope = await resolveCourseScope({ userId: user?.id, scope: searchParams.get('scope'), courseId: searchParams.get('courseId') });
  } catch (error) {
    if (error instanceof LearnerContextError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  const words = query.split(/\s+/).filter((word) => word.length > 1).slice(0, 6);
  const terms = words.length > 0 ? words : [query];
  const questionFilters: Prisma.PastPaperQuestionWhereInput[] = terms.flatMap((term) => [
    { content: { contains: term, mode: 'insensitive' as const } },
    { topic: { contains: term, mode: 'insensitive' as const } },
  ]);

  // Question text does not contain identifiers such as "0610" or
  // "0610-S25-P2v1-Q4", so include paper and subject metadata explicitly.
  questionFilters.push(
    { paper: { filename: { contains: query, mode: 'insensitive' } } },
    { paper: { subject: { code: { contains: query, mode: 'insensitive' } } } },
    { paper: { subject: { name: { contains: query, mode: 'insensitive' } } } },
  );

  const syllabusCode = query.match(/(?:^|\D)(\d{4})(?:\D|$)/)?.[1];
  const questionNumber = query.match(/(?:^|\W)q(?:uestion)?\s*(\d+)/i)?.[1];

  if (syllabusCode || questionNumber) {
    questionFilters.push({
      AND: [
        ...(syllabusCode ? [{ paper: { subject: { code: syllabusCode } } }] : []),
        ...(questionNumber ? [{ number: Number(questionNumber) }] : []),
      ],
    });
  }

  const [questions, markschemes, notes, pages, documents, resources] = await Promise.all([
    prisma.pastPaperQuestion.findMany({
      where: { docType: 'qp', OR: questionFilters, ...(courseScope.effectiveScope === 'enrolled' ? { paper: { subject: { code: { in: courseScope.subjectCodes } } } } : {}) },
      include: { paper: { include: { subject: true } } },
      take: 8,
      orderBy: { id: 'desc' },
    }),
    prisma.pastPaperQuestion.findMany({
      where: { docType: 'ms', OR: questionFilters, ...(courseScope.effectiveScope === 'enrolled' ? { paper: { subject: { code: { in: courseScope.subjectCodes } } } } : {}) },
      include: { paper: { include: { subject: true } } },
      take: 5,
      orderBy: { id: 'desc' },
    }),
    user ? prisma.note.findMany({
      where: {
        AND: [
          { OR: [{ userId: user.id }, { isPublic: true }, { collaborators: { some: { userId: user.id } } }] },
          ...(courseScope.effectiveScope === 'enrolled' ? [{ OR: [{ courseId: { in: courseScope.courseIds } }, { courseId: null }] }] : []),
          { OR: terms.flatMap((term) => [
            { title: { contains: term, mode: 'insensitive' as const } },
            { content: { contains: term, mode: 'insensitive' as const } },
          ]) },
        ],
      },
      take: 6,
      orderBy: { updatedAt: 'desc' },
    }) : Promise.resolve([]),
    user ? prisma.page.findMany({
      where: {
        AND: [
          { OR: [{ section: { notebook: { userId: user.id } } }, { collaborators: { some: { userId: user.id } } }] },
          ...(courseScope.effectiveScope === 'enrolled' ? [{ OR: [{ section: { notebook: { courseId: { in: courseScope.courseIds } } } }, { section: { notebook: { courseId: null } } }] }] : []),
          { OR: terms.flatMap((term) => [
            { title: { contains: term, mode: 'insensitive' as const } },
            { content: { contains: term, mode: 'insensitive' as const } },
            { tags: { has: term } },
          ]) },
        ],
      },
      include: { section: { include: { notebook: true } } },
      take: 6,
      orderBy: { updatedAt: 'desc' },
    }) : Promise.resolve([]),
    user ? prisma.cloudDocument.findMany({
      where: {
        ownerId: user.id,
        deletedAt: null,
        NOT: { clientId: { startsWith: 'page:' } },
        OR: terms.flatMap((term) => [
          { title: { contains: term, mode: 'insensitive' as const } },
          { body: { contains: term, mode: 'insensitive' as const } },
        ]),
      },
      take: 6,
      orderBy: { updatedAt: 'desc' },
    }) : Promise.resolve([]),
    prisma.schoolResource.findMany({
      where: {
        ...(courseScope.effectiveScope === 'enrolled' ? { subject: { in: courseScope.subjects } } : {}),
        OR: terms.flatMap((term) => [
          { title: { contains: term, mode: 'insensitive' as const } },
          { description: { contains: term, mode: 'insensitive' as const } },
          { subject: { contains: term, mode: 'insensitive' as const } },
        ]),
      },
      take: 6,
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const results: SearchResult[] = [
    ...questions.map((question) => ({
      id: `question-${question.id}`,
      type: 'question' as const,
      title: `${question.paper.subject.code} Q${question.number}${question.part}${question.subPart} - ${question.topic}`,
      snippet: plainText(question.content, 240),
      url: `/?tab=practice&qid=${question.id}`,
      subject: question.paper.subject.name,
      topic: question.topic,
    })),
    ...markschemes.map((scheme) => ({
      id: `markscheme-${scheme.id}`,
      type: 'markscheme' as const,
      title: `${scheme.paper.subject.code} mark scheme Q${scheme.number}${scheme.part}${scheme.subPart}`,
      snippet: plainText(scheme.content, 240),
      url: `/?tab=practice&qid=${scheme.id}`,
      subject: scheme.paper.subject.name,
      topic: scheme.topic,
    })),
    ...notes.map((note) => ({
      id: `note-${note.id}`,
      type: 'note' as const,
      title: note.title,
      snippet: plainText(note.content, 240),
      url: '/?tab=materials',
      subject: note.tags[0] ?? null,
    })),
    ...pages.map((page) => ({
      id: `page-${page.id}`,
      type: 'textbook' as const,
      title: `${page.section.notebook.name}: ${page.title}`,
      snippet: plainText(page.content, 240),
      url: '/?tab=materials',
      subject: page.section.notebook.name,
    })),
    ...documents.map((document) => ({
      id: `document-${document.id}`,
      type: 'note' as const,
      title: document.title,
      snippet: plainText(document.body, 240),
      url: '/?tab=materials',
    })),
    ...resources.map((resource) => ({
      id: `resource-${resource.id}`,
      type: 'resource' as const,
      title: resource.title,
      snippet: plainText(resource.description || resource.fileName, 240),
      url: resource.fileUrl,
      subject: resource.subject,
      topic: resource.category,
    })),
  ];

  return NextResponse.json({ results, query, counts: countTypes(results), scope: courseScope });
}

function countTypes(results: SearchResult[]) {
  return results.reduce<Record<string, number>>((counts, result) => {
    counts[result.type] = (counts[result.type] ?? 0) + 1;
    return counts;
  }, {});
}
